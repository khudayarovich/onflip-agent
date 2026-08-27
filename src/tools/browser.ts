import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, BrowserContext, Page } from "playwright";
import { ToolDefinition, ToolResult } from "../types";
import { configDir, loadConfig } from "../config";
import { logger } from "../log";
import { err, ok, denied, asBool, asNumber, clip } from "./util";

/**
 * A browser the agent drives itself.
 *
 * Deliberately *not* the browser in `chatgpt/browser-client.ts`. That one is
 * the model connection: a stray navigation in it ends the conversation the
 * agent is having. This is a second, separate profile that exists only to be
 * clicked around in, and logging into a site here has no bearing on the
 * ChatGPT session.
 *
 * It is driven by the accessibility tree rather than by pixels. The model
 * cannot see — the transport carries text — so every snapshot numbers the
 * page's interactive elements and the agent acts on those numbers. That is
 * also the more reliable half of the trade: a ref survives a layout shift,
 * a coordinate does not.
 */

let context: BrowserContext | null = null;
let page: Page | null = null;

/** Refs are only meaningful for the snapshot that created them. */
let snapshotSerial = 0;

function profileDir(): string {
  const dir = path.join(configDir(), "browser-automation");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function shotsDir(): string {
  const dir = path.join(configDir(), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The agent's own browser — the bundled Chromium, not the user's Chrome.
 *
 * It used to launch `channel: "chrome"`, which starts the Chrome the user has
 * installed. The profile was still separate, but the application was theirs,
 * so a web fetch opened what looked like their own browser. Playwright's
 * bundled build is unmistakably the app's, and with the desktop panel
 * mirroring it there is no longer a reason to borrow Chrome for this.
 *
 * The transport's launcher still prefers real Chrome — that one is talking to
 * ChatGPT, where a familiar browser earns its Cloudflare clearance more
 * easily. `ONFLIP_BROWSER_CHANNEL` overrides this when a site needs Chrome.
 */
async function launch(headless: boolean): Promise<BrowserContext> {
  const preferred = process.env.ONFLIP_BROWSER_CHANNEL ?? "chromium";
  const options = {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  };
  if (preferred !== "chromium") {
    try {
      return await chromium.launchPersistentContext(profileDir(), { ...options, channel: preferred });
    } catch (e) {
      logger.debug("browser-tool", "channel unavailable, using bundled chromium", {
        channel: preferred,
        error: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
    }
  }
  return chromium.launchPersistentContext(profileDir(), options);
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // The env var wins so a script can drive this without touching config;
  // a window that steals focus is fine for a person and not for a test.
  // Windowless by default: the desktop shows this browser in its own panel,
  // so a second window popping up in front of the app is noise rather than
  // information. Settings has a switch for anyone who wants the window.
  const forced = process.env.ONFLIP_BROWSER_HEADLESS;
  const headless = forced ? forced !== "0" && forced !== "false" : loadConfig().browserHeadless ?? true;
  context = await launch(headless);
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  logger.info("browser-tool", "opened the automation browser", { headless });
  return page;
}

/** Shut the automation browser down. Safe to call when it never started. */
export async function closeAutomationBrowser(): Promise<void> {
  try {
    if (context) await context.close();
  } catch {
    /* already gone */
  } finally {
    context = null;
    page = null;
    frameSink?.({ closed: true });
  }
}

export function automationBrowserOpen(): boolean {
  return Boolean(page && !page.isClosed());
}

// ---------------------------------------------------------------------------
// live view — mirroring the agent's browser into the desktop panel
// ---------------------------------------------------------------------------

/**
 * A frame of the agent's browser, sent to whatever wants to display it.
 *
 * The agent's Chromium is a separate OS window that cannot be embedded in the
 * Electron app, so the desktop panel is fed screenshots instead: after every
 * action the current page is captured and handed to the sink, which the engine
 * forwards to the UI. `closed` marks the browser going away so the panel can
 * retire itself.
 */
export interface BrowserFrame {
  image?: string;
  url?: string;
  title?: string;
  note?: string;
  closed?: boolean;
}

let frameSink: ((frame: BrowserFrame) => void) | null = null;

export function setBrowserFrameSink(sink: ((frame: BrowserFrame) => void) | null): void {
  frameSink = sink;
}

/** Capture the page and push it to the panel. Never throws into a tool run. */
async function emitFrame(p: Page, note?: string): Promise<void> {
  if (!frameSink) return;
  try {
    const buffer = await p.screenshot({ type: "jpeg", quality: 55, fullPage: false, timeout: 8_000 });
    frameSink({
      image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      url: p.url(),
      title: (await p.title().catch(() => "")) || undefined,
      note,
    });
  } catch (e) {
    logger.debug("browser-tool", "could not capture a frame", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// the snapshot
// ---------------------------------------------------------------------------

/**
 * Tag every visible, interactive element with a ref and describe it.
 *
 * A string rather than a function because this file compiles without the DOM
 * lib — and, as `browser-client.ts` learned the hard way, a stringified
 * function is only *called* when it is given an argument.
 */
const SNAPSHOT = `(limit) => {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    'summary', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
  ].join(',');

  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);

  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const target = document.getElementById(labelled);
      if (target) return clean(target.innerText);
    }
    return (
      clean(el.getAttribute('aria-label')) ||
      clean(el.innerText) ||
      clean(el.getAttribute('placeholder')) ||
      clean(el.getAttribute('title')) ||
      clean(el.getAttribute('alt')) ||
      clean(el.getAttribute('name')) ||
      clean(el.value)
    );
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') return type;
      if (type === 'password') return 'password';
      return 'textbox';
    }
    return 'element';
  };

  // Refs from an earlier snapshot must not survive into this one, or a stale
  // number silently points at whatever used to be there.
  for (const old of document.querySelectorAll('[data-onflip-ref]')) {
    old.removeAttribute('data-onflip-ref');
  }

  const elements = [];
  let seen = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) < 0.05) continue;
    if (el.disabled) continue;

    seen++;
    if (elements.length >= limit) continue;
    const ref = 'ref_' + (elements.length + 1);
    el.setAttribute('data-onflip-ref', ref);
    elements.push({
      ref,
      role: roleOf(el),
      name: nameOf(el),
      value: typeof el.value === 'string' ? clean(el.value) : '',
      checked: el.checked === true,
    });
  }

  return {
    url: location.href,
    title: document.title || '',
    elements,
    hidden: seen - elements.length,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim(),
  };
}`;

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value: string;
  checked: boolean;
}

interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  hidden: number;
  text: string;
}

const MAX_ELEMENTS = 120;
const MAX_TEXT = 3_000;

async function snapshot(p: Page): Promise<Snapshot> {
  // The page can be mid-navigation; one retry covers the usual race.
  //
  // Self-invoked rather than passed an argument. Whether a stringified
  // function gets *called* depends on Playwright's heuristics, and the
  // failure mode is silent: an uncalled function is unserialisable, so the
  // result is undefined and everything downstream reads properties of it.
  const expression = `(${SNAPSHOT})(${MAX_ELEMENTS})`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const shot = (await p.evaluate(expression)) as Snapshot | undefined;
      if (shot && Array.isArray(shot.elements)) return shot;
      throw new Error("the page returned no snapshot");
    } catch (e) {
      if (attempt === 1) throw e;
      await p.waitForTimeout(500);
    }
  }
  throw new Error("unreachable");
}

/** Render a snapshot as the text the model reads. */
function describe(shot: Snapshot, note?: string): string {
  snapshotSerial++;
  const lines: string[] = [];
  if (note) lines.push(note, "");
  lines.push(`url: ${shot.url}`);
  if (shot.title) lines.push(`title: ${shot.title}`);
  lines.push("");

  if (shot.elements.length) {
    lines.push("interactive elements (act on these by ref):");
    for (const el of shot.elements) {
      const bits = [`  [${el.ref}]`, el.role];
      if (el.name) bits.push(JSON.stringify(el.name));
      if (el.value) bits.push(`= ${JSON.stringify(el.value)}`);
      if (el.checked) bits.push("(checked)");
      lines.push(bits.join(" "));
    }
    if (shot.hidden > 0) {
      lines.push(`  … and ${shot.hidden} more, not listed. Scroll or narrow the page to reach them.`);
    }
  } else {
    lines.push("interactive elements: none found on this page");
  }

  lines.push("", "page text:", clip(shot.text, MAX_TEXT));
  return lines.join("\n");
}

/** The locator for a ref, or an error explaining why there is not one. */
async function locate(p: Page, rawRef: unknown): Promise<{ ref: string } | { error: ToolResult }> {
  const ref = String(rawRef ?? "").trim();
  if (!ref) {
    return { error: err("`ref` must be a ref from the latest browser snapshot, such as ref_3.") };
  }
  const count = await p.locator(`[data-onflip-ref="${ref}"]`).count();
  if (count === 0) {
    return {
      error: err(
        `${ref} is not on the page. Refs only describe the snapshot that produced them, and the page has changed since — call browser_snapshot and use a ref from that.`
      ),
    };
  }
  return { ref };
}

/** Gate a browser action the way a network request is gated. */
async function allowed(
  ctx: Parameters<ToolDefinition["run"]>[1],
  tool: string,
  subject: string,
  detail?: string[]
): Promise<ToolResult | null> {
  const decision = await ctx.requestPermission({ kind: "network", tool, subject, detail });
  return decision.allow ? null : denied("Browser action", decision.reason);
}

/** Everything settles into the same answer: what the page looks like now. */
async function respond(p: Page, note: string): Promise<ToolResult> {
  // A click usually starts a navigation or a re-render; give it a moment
  // rather than snapshotting the page that is about to be replaced.
  await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await p.waitForTimeout(400);
  const shot = await snapshot(p);
  // Mirror the result into the desktop's browser panel, if one is listening.
  void emitFrame(p, note);
  return ok(describe(shot, note), { title: shot.title || shot.url });
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

const REF_ARG = {
  ref: { type: "string", description: "Element ref from the most recent snapshot, e.g. ref_7" },
};

export const browserOpenTool: ToolDefinition = {
  name: "browser_open",
  description:
    "Open a URL in the agent's own browser and return a snapshot of the page: its interactive elements, each with a ref, plus the visible text. Also accepts `back` or `forward` to move through history. This browser is separate from your own and keeps its logins between runs.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL, or `back` / `forward`" },
    },
    required: ["url"],
  },
  async run(args, ctx) {
    const raw = String(args.url ?? "").trim();
    if (!raw) return err("`url` must be non-empty");

    const p = await ensurePage();

    if (raw === "back" || raw === "forward") {
      const stop = await allowed(ctx, "browser_open", `go ${raw}`);
      if (stop) return stop;
      const moved = raw === "back" ? await p.goBack() : await p.goForward();
      if (!moved) return err(`There is nothing ${raw} of this page in the history.`);
      return respond(p, `Went ${raw}.`);
    }

    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return err(`Not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return err(`Unsupported protocol: ${url.protocol}. Only http and https are allowed.`);
    }

    const stop = await allowed(ctx, "browser_open", url.href, [`host: ${url.host}`]);
    if (stop) return stop;

    logger.info("browser-tool", "navigating", { url: url.href });
    try {
      await p.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      return err(`Could not open ${url.href}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return respond(p, `Opened ${url.href}`);
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: "browser_snapshot",
  description:
    "Re-read the current page in the agent's browser: its interactive elements with fresh refs, and its visible text. Call this after the page changes, or when a ref has gone stale.",
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    if (!automationBrowserOpen()) {
      return err("No page is open. Use browser_open first.");
    }
    const p = await ensurePage();
    const shot = await snapshot(p);
    return ok(describe(shot), { title: shot.title || shot.url });
  },
};

export const browserClickTool: ToolDefinition = {
  name: "browser_click",
  description:
    "Click an element in the agent's browser by its ref, then return a fresh snapshot of the resulting page.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      ...REF_ARG,
      description: { type: "string", description: "What this element is, for the approval prompt" },
    },
    required: ["ref"],
  },
  async run(args, ctx) {
    if (!automationBrowserOpen()) return err("No page is open. Use browser_open first.");
    const p = await ensurePage();

    const found = await locate(p, args.ref);
    if ("error" in found) return found.error;

    const label = String(args.description ?? "").trim() || found.ref;
    const stop = await allowed(ctx, "browser_click", `click ${label}`, [`page: ${p.url()}`]);
    if (stop) return stop;

    try {
      await p.locator(`[data-onflip-ref="${found.ref}"]`).click({ timeout: 15_000 });
    } catch (e) {
      return err(
        `Could not click ${found.ref}: ${e instanceof Error ? e.message : String(e)}. It may be covered by something else, or off screen — snapshot the page again.`
      );
    }
    return respond(p, `Clicked ${label}.`);
  },
};

export const browserTypeTool: ToolDefinition = {
  name: "browser_type",
  description:
    "Type text into a field in the agent's browser, identified by its ref. Set submit: true to press Enter afterwards. Returns a fresh snapshot.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      ...REF_ARG,
      text: { type: "string", description: "Text to type. Replaces whatever is in the field." },
      submit: { type: "boolean", description: "Press Enter after typing" },
    },
    required: ["ref", "text"],
  },
  async run(args, ctx) {
    if (!automationBrowserOpen()) return err("No page is open. Use browser_open first.");
    const p = await ensurePage();

    const found = await locate(p, args.ref);
    if ("error" in found) return found.error;
    const text = String(args.text ?? "");
    const submit = asBool(args.submit);

    // The value is shown to the user, so a password does not go on screen.
    // Read as an attribute — the reliable path; an evaluate here is the
    // stringified-function trap all over again.
    const fieldType = await p
      .locator(`[data-onflip-ref="${found.ref}"]`)
      .getAttribute("type")
      .catch(() => null);
    const isSecret = fieldType === "password";
    const shown = isSecret ? "•".repeat(Math.min(text.length, 12)) : clip(text, 60);

    const stop = await allowed(ctx, "browser_type", `type into ${found.ref}: ${shown}`, [
      `page: ${p.url()}`,
      submit ? "and press Enter" : "without submitting",
    ]);
    if (stop) return stop;

    try {
      const field = p.locator(`[data-onflip-ref="${found.ref}"]`);
      await field.fill(text, { timeout: 15_000 });
      if (submit) await field.press("Enter");
    } catch (e) {
      return err(`Could not type into ${found.ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return respond(p, `Typed into ${found.ref}${submit ? " and pressed Enter" : ""}.`);
  },
};

export const browserKeyTool: ToolDefinition = {
  name: "browser_key",
  description:
    "Press a key in the agent's browser — Enter, Tab, Escape, ArrowDown, PageDown, End, or a chord like Control+A. Use PageDown/End to reach elements a snapshot said were not listed. Returns a fresh snapshot.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Key or chord, e.g. Enter, Escape, PageDown, Control+A" },
      repeat: { type: "number", description: "Press it this many times (default 1, max 20)" },
    },
    required: ["key"],
  },
  async run(args, ctx) {
    if (!automationBrowserOpen()) return err("No page is open. Use browser_open first.");
    const p = await ensurePage();

    const key = String(args.key ?? "").trim();
    if (!key) return err("`key` must be non-empty, e.g. Enter or PageDown.");
    const times = Math.min(20, Math.max(1, asNumber(args.repeat) ?? 1));

    const stop = await allowed(ctx, "browser_key", `press ${key}${times > 1 ? ` ×${times}` : ""}`, [
      `page: ${p.url()}`,
    ]);
    if (stop) return stop;

    try {
      for (let i = 0; i < times; i++) await p.keyboard.press(key);
    } catch (e) {
      return err(`Could not press ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return respond(p, `Pressed ${key}${times > 1 ? ` ${times} times` : ""}.`);
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: "browser_screenshot",
  description:
    "Save a PNG of the current page for the user to look at, and return where it went. You cannot see the image yourself — use browser_snapshot to read the page.",
  parameters: {
    type: "object",
    properties: {
      full_page: { type: "boolean", description: "Capture the whole scrollable page, not just the viewport" },
    },
    required: [],
  },
  async run(args) {
    if (!automationBrowserOpen()) return err("No page is open. Use browser_open first.");
    const p = await ensurePage();

    // Written under ~/.onflip rather than into the user's project, which is
    // not the agent's to litter.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(shotsDir(), `${stamp}.png`);
    try {
      await p.screenshot({ path: file, fullPage: asBool(args.full_page) });
    } catch (e) {
      return err(`Could not take a screenshot: ${e instanceof Error ? e.message : String(e)}`);
    }
    void emitFrame(p, "Screenshot");
    return ok(`Saved a screenshot of ${p.url()} to ${file}. Tell the user the path — you cannot see it.`, {
      title: path.basename(file),
    });
  },
};

export const browserCloseTool: ToolDefinition = {
  name: "browser_close",
  description:
    "Close the agent's browser. Its profile and logins survive; only the window goes. Do this when the browsing part of a task is finished.",
  mutates: true,
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    if (!automationBrowserOpen()) return ok("The browser was not open.");
    await closeAutomationBrowser();
    return ok("Closed the browser.");
  },
};

export const BROWSER_TOOLS: ToolDefinition[] = [
  browserOpenTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserKeyTool,
  browserScreenshotTool,
  browserCloseTool,
];
