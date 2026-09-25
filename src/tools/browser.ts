import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, BrowserContext, Page } from "playwright";
import { ToolDefinition, ToolResult } from "../types";
import { configDir, loadConfig } from "../config";
import { logger } from "../log";
import { err, ok, denied, asArray, asBool, asNumber, clip } from "./util";
import { ensureBundledBrowser } from "../chatgpt/browser-client";
import { realPath } from "../agent/permissions";

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
/**
 * Set when this page is the desktop's own docked view rather than a browser
 * this process launched.
 *
 * Two things follow from it. Nothing here may close that browser — it is the
 * app window, and quitting it would take the whole desktop with it. And the
 * screencast is pointless: the user is looking at the real thing.
 */
let embedded = false;

/**
 * Attach to the browser view the desktop has docked into its own window.
 *
 * Electron is Chromium, so a `WebContentsView` answers the DevTools protocol
 * exactly like a tab, and Playwright drives it over CDP with every tool in
 * this file working unchanged. What this buys is not a shorter code path but
 * a real browser on screen: composited with the rest of the UI, sharp at any
 * pixel density, with working hover and native scrolling — none of which a
 * screencast can have.
 *
 * The mark is how the right page is picked. The endpoint also exposes the
 * app's own interface, which is a page too and emphatically not something to
 * hand to an agent, so the view is parked on a URL carrying a nonce the
 * desktop generated. Playwright's handle survives navigation, so it only has
 * to be found once.
 */
async function attachEmbedded(endpoint: string, mark: string): Promise<Page | null> {
  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 5_000 });
    for (const ctx of browser.contexts()) {
      for (const candidate of ctx.pages()) {
        if (!candidate.url().includes(mark)) continue;
        context = ctx;
        embedded = true;
        // Attaching must leave the view sized by its window and nothing else.
        // Playwright can carry a viewport of its own into a CDP-attached
        // page, and an earlier run of this session may have left an override
        // behind; either one renders the page at a size the frame does not
        // have. Clearing costs one message and heals a view already wrong.
        try {
          const cdp = await ctx.newCDPSession(candidate);
          await cdp.send("Emulation.clearDeviceMetricsOverride");
          await cdp.detach().catch(() => {});
        } catch (e) {
          logger.debug("browser-tool", "could not clear the view's metrics override", {
            error: e instanceof Error ? e.message.slice(0, 120) : String(e),
          });
        }
        logger.info("browser-tool", "attached to the desktop's browser view", { endpoint });
        return candidate;
      }
    }
    // Connected, but the view is not there — a window that has not opened one
    // yet, or a build where creating it failed. Launching our own is a worse
    // experience, not a broken one.
    logger.warn("browser-tool", "no marked view on the desktop endpoint; launching instead");
    await browser.close().catch(() => {});
  } catch (e) {
    logger.warn("browser-tool", "could not attach to the desktop's browser view", {
      endpoint,
      error: e instanceof Error ? e.message.slice(0, 160) : String(e),
    });
  }
  return null;
}

/**
 * The size the agent's browser renders at.
 *
 * Portrait by default, and narrow enough that sites serve their mobile
 * layout — because the desktop shows this browser in a side panel, and a
 * 1280x900 desktop page shrunk into a tall column is unreadable. The panel
 * reports its own size as it is dragged, so the page reflows to fill it
 * rather than being letterboxed inside it.
 */
let viewport = { width: 430, height: 932 };

/** A narrow viewport is a phone, and should be told so to get mobile layouts. */
function isMobileShape(w: number): boolean {
  return w < 700;
}

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Mobile Safari/537.36";

/**
 * Match the agent's browser to the panel showing it.
 *
 * Applied live where possible; a change of shape between phone and desktop
 * also changes the user agent and touch support, which only a relaunch can
 * pick up, so that is deferred to the next launch rather than forced.
 */
/** The panel's devicePixelRatio, so frames carry real pixels, not CSS ones. */
let panelScale = 1;
/** The deviceScaleFactor the running browser was actually launched with. */
let launchedScale = 1;

export async function setBrowserViewport(width: number, height: number, scale?: number): Promise<void> {
  if (typeof scale === "number" && Number.isFinite(scale)) {
    // Capped at 2: past that the frames cost more than the eye gets back.
    panelScale = Math.max(1, Math.min(2, Math.round(scale * 100) / 100));
  }
  const next = {
    width: Math.max(320, Math.min(2000, Math.round(width))),
    height: Math.max(480, Math.min(2000, Math.round(height))),
  };
  if (next.width === viewport.width && next.height === viewport.height) return;
  viewport = next;
  // The docked view is sized by the window itself, so nothing here may
  // emulate its metrics. `setViewportSize` is `Emulation.setDeviceMetricsOverride`
  // underneath, which pins the page to one render size inside a frame that
  // goes on being resized — the page then sits misaligned with its own panel
  // and stays that way, which is what a resized panel did to the real view.
  // The size is still recorded above: the fallback browser launches from it,
  // and that one genuinely needs the override.
  if (embedded) return;
  if (page && !page.isClosed()) {
    await page.setViewportSize(next).catch(() => {
      /* the page is busy; the next launch picks it up */
    });
    // The screencast's frame size was fixed when it started; a resized
    // panel otherwise keeps receiving frames sized for the old one, scaled
    // up in the renderer — which reads as a blurry stream.
    if (cast?.page === page) {
      const p = page;
      await stopScreencast();
      void startScreencast(p);
    }
  }
}

/** Refs are only meaningful for the snapshot that created them. */
let snapshotSerial = 0;

/**
 * The page the model was last shown, by content, and when.
 *
 * Every action already answers with a fresh snapshot, and models ask for
 * one straight afterwards anyway — a round trip, and up to six thousand
 * characters of the page they were just shown. When nothing has changed,
 * `browser_snapshot` says so in a line instead: same page, same refs. Held
 * to a short window, because an older snapshot may have been trimmed out
 * of the conversation since, and to once in a row, because a model that
 * asks again after being told has a reason to want the page itself.
 */
let lastShown: { key: string; at: number; brief: boolean } | null = null;
const SAME_PAGE_WINDOW_MS = 90_000;

/** Everything the model reads from a snapshot, as one comparable string. */
function snapshotKey(shot: Snapshot): string {
  return JSON.stringify([shot.url, shot.title, shot.elements, shot.hidden, shot.text]);
}

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
/**
 * Set when a launch failed in a way this session cannot recover from — no
 * Chrome, no Edge, and the bundled download failed too. A session in the
 * field tried browser verification three separate times, minutes apart, and
 * paid the full download timeout for each; the machine had not grown a
 * browser in between. The first failure is the answer for the whole session.
 */
let launchDeadReason: string | null = null;

async function launch(headless: boolean): Promise<BrowserContext> {
  if (launchDeadReason) throw new Error(launchDeadReason);
  const preferred = process.env.ONFLIP_BROWSER_CHANNEL ?? "chromium";
  const mobile = isMobileShape(viewport.width);
  // Phone shapes always render at 2× like a real phone; desktop shapes
  // render at the panel's own pixel density. The old default was 1× for
  // desktop — every frame was captured in CSS pixels and stretched across a
  // HiDPI panel, which is most of why the stream looked like low-quality
  // video the moment the panel was wide.
  launchedScale = mobile ? 2 : panelScale;
  const options = {
    headless,
    viewport: { ...viewport },
    deviceScaleFactor: launchedScale,
    // A phone-shaped viewport that still claims to be a desktop gets desktop
    // HTML reflowed into a column, which is the worst of both.
    ...(mobile ? { userAgent: MOBILE_UA, isMobile: true, hasTouch: true } : {}),
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
  try {
    return await chromium.launchPersistentContext(profileDir(), options);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/Executable doesn'?t exist|Please run.*playwright install/i.test(message)) throw e;
    // No Chrome, no Edge, and no bundled build yet. The transport has fetched
    // its own browser on demand for a long time; this tool did not, so it
    // handed Playwright's raw message — "run npx playwright install" —
    // straight to the model. Seen live: the agent dutifully ran that, the
    // download timed out, and a turn was spent on advice that could not work
    // from inside the sandbox anyway.
    logger.info("browser-tool", "no browser installed; fetching the bundled one");
    if (await ensureBundledBrowser(undefined, headless)) {
      return await chromium.launchPersistentContext(profileDir(), options);
    }
    launchDeadReason =
      "The agent's browser could not start earlier this session: Chrome and Edge are not installed, and the bundled browser could not be downloaded. " +
      "That will not change until Google Chrome is installed (or the network is back) and OnFlip is restarted. Do not call browser tools again this session — verify another way.";
    throw new Error(
      "The agent's browser could not start: Chrome and Edge are not installed, and the bundled browser could not be downloaded. " +
        "Check the network, or install Google Chrome. Running `npx playwright install` will not help — OnFlip fetches its own copy. " +
        "Until one of those changes, browser tools cannot work — verify another way instead of retrying."
    );
  }
}

/**
 * Close the browser on its own once nothing has used it for a while.
 *
 * The system prompt asks the model to call browser_close when the browsing
 * part of a task ends, and models forget — which left a headless Chromium
 * and its screencast running for hours after a two-minute lookup. Every use
 * re-arms this timer (the user clicking in the panel included), so a flow
 * that spans turns keeps its page, and a forgotten browser reaps itself.
 * The persistent profile keeps logins either way; only the open page is
 * lost, and a fresh one is a launch away.
 */
const BROWSER_IDLE_MS = Math.max(
  60_000,
  (Number(process.env.ONFLIP_BROWSER_IDLE_SECONDS) || 180) * 1_000
);
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    logger.info("browser-tool", "closing the automation browser after idle", {
      idleMs: BROWSER_IDLE_MS,
    });
    void closeAutomationBrowser();
  }, BROWSER_IDLE_MS);
  // A pending close must never be what keeps the process alive.
  idleTimer.unref?.();
}

async function ensurePage(): Promise<Page> {
  armIdleClose();
  if (page && !page.isClosed()) return page;

  // The desktop's own docked view, when there is one. Tried first and every
  // time, because a window can be opened after this process started.
  const endpoint = process.env.ONFLIP_EMBEDDED_CDP;
  const mark = process.env.ONFLIP_EMBEDDED_MARK;
  if (endpoint && mark) {
    const attached = await attachEmbedded(endpoint, mark);
    if (attached) {
      page = attached;
      page.setDefaultTimeout(20_000);
      // No screencast: the user is looking at the real view, and streaming
      // frames of a page already on screen is pure waste.
      return page;
    }
  }

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
  logger.info("browser-tool", "opened the automation browser", {
    headless,
    viewport,
    mobile: isMobileShape(viewport.width),
  });
  void startScreencast(page);
  return page;
}

/** Shut the automation browser down. Safe to call when it never started. */
export async function closeAutomationBrowser(): Promise<void> {
  lastShown = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  // The docked view belongs to the desktop, not to this process, and its
  // context is the whole Electron app — closing it would take the window,
  // the transcript and every other panel with it. `browser_close` is a
  // routine call the model makes at the end of a browsing task, so this is
  // not a corner case: it is what would happen every single time. Blanking
  // the page is the equivalent gesture, and the view is reused afterwards.
  if (embedded) {
    try {
      // Back to the marked page, not `about:blank`: the mark in that URL is
      // how the next `browser_open` finds this view again among the app's own
      // pages, and blanking it plainly would strand the view for the rest of
      // the session.
      const blank = process.env.ONFLIP_EMBEDDED_BLANK;
      if (page && !page.isClosed() && blank) await page.goto(blank);
    } catch {
      /* the window went away on its own */
    }
    page = null;
    context = null;
    embedded = false;
    frameSink?.({ closed: true });
    return;
  }
  try {
    if (context) await context.close();
  } catch {
    /* already gone */
  } finally {
    await stopScreencast();
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
  /** True for a streamed frame, false for a still taken after an action. */
  live?: boolean;
}

let frameSink: ((frame: BrowserFrame) => void) | null = null;
/** The live screencast, when one is running. */
let cast: { session: import("playwright").CDPSession; page: Page } | null = null;

export function setBrowserFrameSink(sink: ((frame: BrowserFrame) => void) | null): void {
  frameSink = sink;
  if (!sink) void stopScreencast();
}

/**
 * Stream the agent's browser, rather than photographing it.
 *
 * A screenshot after each action shows where the page ended up and nothing of
 * how it got there — scrolling, typing and page loads all happen between
 * frames, so it reads as a slideshow rather than a browser. Chrome's own
 * screencast pushes a frame whenever the page actually changes, which is what
 * makes it look live, and it costs less than polling: nothing is captured
 * while the page is still.
 */
async function startScreencast(p: Page): Promise<void> {
  if (!frameSink || cast?.page === p) return;
  await stopScreencast();
  try {
    const session = await p.context().newCDPSession(p);
    session.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
      // Acknowledge first: Chrome sends no further frames until it is.
      void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      frameSink?.({
        image: `data:image/jpeg;base64,${frame.data}`,
        url: p.url(),
        live: true,
      });
    });
    await session.send("Page.startScreencast", {
      format: "jpeg",
      // 55 smeared text into the "low-quality video" look; 82 is visually
      // clean on text and still a fraction of PNG weight.
      quality: 82,
      // Real pixels: the page renders at launchedScale, and capping the
      // capture at CSS size threw those pixels away before they reached
      // the panel.
      maxWidth: Math.round(viewport.width * launchedScale),
      maxHeight: Math.round(viewport.height * launchedScale),
      everyNthFrame: 1,
    });
    cast = { session, page: p };
    logger.info("browser-tool", "streaming the browser to the desktop panel");
  } catch (e) {
    // A stream is a nicety; the per-action frames below still work.
    logger.debug("browser-tool", "could not start the screencast", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The user acting on the streamed page, straight from the panel.
 *
 * The stream used to carry pixels one way, and the panel said so: a view,
 * not a control surface. But a browser you can watch and not touch is a
 * broken vending machine — the page asks for a cookie choice or a scroll,
 * and the user can only tell the agent to do it in words. Coordinates
 * arrive as fractions of the frame so the panel's own scaling never has to
 * agree with the viewport; keys arrive in Playwright's spelling, composed
 * by the panel. The agent may be driving the same page — that is the same
 * contract as a human touching a browser Codex is using, and the agent
 * re-snapshots before every action anyway.
 */
export interface BrowserUserInput {
  kind: "click" | "dblclick" | "contextmenu" | "wheel" | "key" | "text";
  /** Position as a fraction of the frame, 0..1. */
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  /** A Playwright key name, modifiers composed ("Control+a"). */
  key?: string;
  text?: string;
}

export async function dispatchBrowserInput(input: BrowserUserInput): Promise<boolean> {
  const p = page;
  if (!p || p.isClosed()) return false;
  // A person interacting with the page is the page being used.
  armIdleClose();
  const size = p.viewportSize() ?? viewport;
  const px = Math.round(Math.max(0, Math.min(1, input.x ?? 0)) * size.width);
  const py = Math.round(Math.max(0, Math.min(1, input.y ?? 0)) * size.height);
  try {
    switch (input.kind) {
      case "click":
        await p.mouse.click(px, py);
        break;
      case "dblclick":
        await p.mouse.dblclick(px, py);
        break;
      case "contextmenu":
        await p.mouse.click(px, py, { button: "right" });
        break;
      case "wheel":
        await p.mouse.move(px, py);
        await p.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
        break;
      case "key":
        if (input.key) await p.keyboard.press(input.key);
        break;
      case "text":
        if (input.text) await p.keyboard.insertText(input.text);
        break;
    }
    return true;
  } catch (e) {
    logger.debug("browser-tool", "panel input did not land", {
      kind: input.kind,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

async function stopScreencast(): Promise<void> {
  const current = cast;
  cast = null;
  if (!current) return;
  try {
    await current.session.send("Page.stopScreencast");
    await current.session.detach();
  } catch {
    /* the page is already gone */
  }
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
 * function is only *called* when it is given an argument. Exported so the
 * suite can run it against a hand-built document.
 */
export const SNAPSHOT = `(limit) => {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    'summary', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
  ].join(',');

  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);

  // A password field's characters never leave the page. This snapshot goes
  // to the model's service after every action and into the transcript, and
  // what is in the field may be nothing the model typed: a password the
  // person entered in the browser panel, or one the profile autofilled.
  // That it is filled, and how long, is all the model needs.
  const secret = (el) =>
    el.tagName.toLowerCase() === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password';
  const masked = (s) => '•'.repeat(Math.min(String(s || '').length, 12));

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
      (secret(el) ? '' : clean(el.value))
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
      value: typeof el.value === 'string' ? (secret(el) ? masked(el.value) : clean(el.value)) : '',
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

  // MAX_TEXT is a character budget, and clip's second argument counts
  // lines — passed there, it let four times the intended text through.
  lines.push("", "page text:", clip(shot.text, Number.POSITIVE_INFINITY, MAX_TEXT));
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

/**
 * Gate a browser action the way a network request is gated.
 *
 * `page` is the address the action acts on — the page being clicked, or the
 * one being opened — which is what "always allow" can remember when it is
 * this machine's own server (see `loopbackOrigin` in the permissions).
 */
async function allowed(
  ctx: Parameters<ToolDefinition["run"]>[1],
  tool: string,
  subject: string,
  detail?: string[],
  page?: string
): Promise<ToolResult | null> {
  const decision = await ctx.requestPermission({ kind: "network", tool, subject, detail, origin: page });
  return decision.allow ? null : denied("Browser action", decision.reason);
}

/**
 * A page in the working folder, opened as a file — or null when `raw` is not
 * one, so it is read as a web address instead.
 *
 * A small page, tool or game is now written as plain HTML that opens without
 * a build, and the first thing the model did with one was try to look at it:
 * `file:///…/index.html`, refused as an unsupported protocol, leaving a local
 * web server — a command, an approval and a background job — as the only way
 * to see the page it had just written. Only inside the working folder, whose
 * files the agent can already read; anything else is refused by name. Both
 * sides go through `realPath`, as a write's do: a link inside the folder can
 * point out of it, and a short 8.3 name is the same folder as its long one.
 */
export function localPageUrl(raw: string, cwd: string): { url: URL } | { error: string } | null {
  let file: string | null = null;
  if (/^file:/i.test(raw)) {
    try {
      file = fileURLToPath(new URL(raw));
    } catch {
      return { error: `Not a valid file URL: ${raw}` };
    }
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /\.x?html?$/i.test(raw.split(/[?#]/)[0])) {
    // A bare path to a page, such as `index.html` or `C:\game\index.html`.
    const candidate = path.resolve(cwd, raw.split(/[?#]/)[0]);
    if (fs.existsSync(candidate)) file = candidate;
  }
  if (file === null) return null;
  const rel = path.relative(realPath(cwd), realPath(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: `Only files in the working folder can be opened in the browser; ${file} is outside it.` };
  }
  return { url: pathToFileURL(file) };
}

/** Everything settles into the same answer: what the page looks like now. */
async function respond(p: Page, note: string): Promise<ToolResult> {
  // A click usually starts a navigation or a re-render; give it a moment
  // rather than snapshotting the page that is about to be replaced.
  await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await p.waitForTimeout(400);
  // Mirror the result into the desktop's browser panel, if one is listening.
  void emitFrame(p, note);
  let shot: Snapshot;
  try {
    shot = await snapshot(p);
  } catch (e) {
    // The action itself is done and cannot be taken back, so a snapshot lost
    // to the navigation it set off must not read as a failure. Reported as
    // one, the model clicked again and a form went in twice.
    const reason = e instanceof Error ? e.message : String(e);
    return ok(
      `${note} The page changed before it could be read (${reason}) — call browser_snapshot to see where it is now.`,
      { title: p.url() }
    );
  }
  lastShown = { key: snapshotKey(shot), at: Date.now(), brief: false };
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
      url: {
        type: "string",
        description: "http(s) URL, a working-folder page by path (index.html), or `back`/`forward`",
      },
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

    const local = localPageUrl(raw, ctx.cwd);
    if (local && "error" in local) return err(local.error);
    let url: URL;
    try {
      url = local ? local.url : new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return err(`Not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") {
      return err(
        `Unsupported protocol: ${url.protocol}. Use an http(s) URL, or a file in the working folder by its path.`
      );
    }

    const stop = await allowed(
      ctx,
      "browser_open",
      url.href,
      [url.protocol === "file:" ? "a file in the working folder" : `host: ${url.host}`],
      url.href
    );
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
    "Re-read the current page in the agent's browser: its interactive elements with fresh refs, and its visible text. Every other browser tool already returns a fresh snapshot, so call this only when a ref has gone stale or the page changed on its own.",
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    if (!automationBrowserOpen()) {
      return err("No page is open. Use browser_open first.");
    }
    const p = await ensurePage();
    const shot = await snapshot(p);
    const key = snapshotKey(shot);
    const age = lastShown ? Date.now() - lastShown.at : Infinity;
    if (lastShown?.key === key && !lastShown.brief && age < SAME_PAGE_WINDOW_MS) {
      lastShown = { key, at: Date.now(), brief: true };
      const count = shot.elements.length;
      return ok(
        `Nothing has changed since the snapshot ${Math.round(age / 1000)}s ago: the same page, the same ${count} interactive element${count === 1 ? "" : "s"} under the same refs, and the same text. Act on those refs — every browser action already returns a fresh snapshot.`,
        { title: shot.title || shot.url }
      );
    }
    lastShown = { key, at: Date.now(), brief: false };
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
    const stop = await allowed(ctx, "browser_click", `click ${label}`, [`page: ${p.url()}`], p.url());
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

/** The most fields one `browser_type` call fills. */
const MAX_FIELDS = 20;

/**
 * What to type where: the `fields` list, or the single `ref` and `text`.
 *
 * A form of five fields used to be five calls, five approvals and five full
 * snapshots of a page nobody needed to see until the form was filled — each
 * one a round trip to the chat model.
 */
function typingPlan(args: Record<string, unknown>): { ref: unknown; text: string }[] | { error: string } {
  const fields = asArray(args.fields);
  if (!fields?.length) return [{ ref: args.ref, text: String(args.text ?? "") }];
  if (fields.length > MAX_FIELDS) {
    return { error: `\`fields\` holds ${fields.length} entries; send at most ${MAX_FIELDS} in one call and the rest in another.` };
  }
  const plan: { ref: unknown; text: string }[] = [];
  for (const [i, item] of fields.entries()) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const text = entry.text ?? entry.value;
    if (!String(entry.ref ?? "").trim() || (typeof text !== "string" && typeof text !== "number")) {
      return { error: `\`fields\` entry ${i + 1} needs a ref and a text, like \`- ref: ref_3\` with \`text: Jane\` under it.` };
    }
    plan.push({ ref: entry.ref, text: String(text) });
  }
  return plan;
}

export const browserTypeTool: ToolDefinition = {
  name: "browser_type",
  description:
    "Type text into a field in the agent's browser, identified by its ref — or fill a whole form at once with `fields`. Set submit: true to press Enter afterwards. Returns a fresh snapshot.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      ...REF_ARG,
      text: { type: "string", description: "Text to type. Replaces whatever is in the field." },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: { ref: { type: "string" }, text: { type: "string" } },
          required: ["ref", "text"],
        },
        description: "Instead of ref and text: several fields, filled in order under one approval and answered with one snapshot",
      },
      submit: { type: "boolean", description: "Press Enter after typing (in the last field)" },
    },
    required: [],
  },
  async run(args, ctx) {
    if (!automationBrowserOpen()) return err("No page is open. Use browser_open first.");
    const p = await ensurePage();

    const plan = typingPlan(args);
    if ("error" in plan) return err(plan.error);
    // Every ref is found before anything is typed: a stale one halfway down
    // would leave the form half filled and the model unsure which half.
    const refs: string[] = [];
    for (const step of plan) {
      const found = await locate(p, step.ref);
      if ("error" in found) return found.error;
      refs.push(found.ref);
    }
    const submit = asBool(args.submit);

    // The value is shown to the user, so a password does not go on screen.
    // Read as an attribute — the reliable path; an evaluate here is the
    // stringified-function trap all over again.
    const shown: string[] = [];
    for (const [i, ref] of refs.entries()) {
      const text = plan[i].text;
      const fieldType = await p
        .locator(`[data-onflip-ref="${ref}"]`)
        .getAttribute("type")
        .catch(() => null);
      // Attribute values keep the page's casing, and `type="Password"` is
      // still a password field.
      const isSecret = fieldType?.toLowerCase() === "password";
      shown.push(
        isSecret ? "•".repeat(Math.min(text.length, 12)) : text.length > 60 ? `${text.slice(0, 60)}…` : text
      );
    }

    const single = refs.length === 1;
    const stop = await allowed(
      ctx,
      "browser_type",
      single ? `type into ${refs[0]}: ${shown[0]}` : `fill ${refs.length} fields: ${refs.join(", ")}`,
      [
        ...(single ? [] : refs.map((ref, i) => `${ref}: ${shown[i]}`)),
        `page: ${p.url()}`,
        submit ? "and press Enter" : "without submitting",
      ],
      p.url()
    );
    if (stop) return stop;

    const filled: string[] = [];
    for (const [i, ref] of refs.entries()) {
      try {
        const field = p.locator(`[data-onflip-ref="${ref}"]`);
        await field.fill(plan[i].text, { timeout: 15_000 });
        filled.push(ref);
        if (submit && i === refs.length - 1) await field.press("Enter");
      } catch (e) {
        const before = filled.length
          ? ` ${filled.join(", ")} ${filled.length === 1 ? "was" : "were"} filled before it; the rest were not.`
          : "";
        return err(`Could not type into ${ref}: ${e instanceof Error ? e.message : String(e)}.${before}`);
      }
    }
    const last = refs[refs.length - 1];
    return respond(
      p,
      single
        ? `Typed into ${last}${submit ? " and pressed Enter" : ""}.`
        : `Filled ${refs.join(", ")}${submit ? `, and pressed Enter in ${last}` : ""}.`
    );
  },
};

/** Key names as Playwright spells them, by their lower-case form and the aliases models write. */
const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  bksp: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  space: "Space",
  spacebar: "Space",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  printscreen: "PrintScreen",
  pause: "Pause",
  contextmenu: "ContextMenu",
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  super: "Meta",
  controlormeta: "ControlOrMeta",
};

/**
 * A key or chord as Playwright spells it.
 *
 * Playwright's names are case-sensitive, and models write keys the way people
 * say them. Live, on this project's own machine: the agent pressed "TAB"
 * while testing a chess page and got `Unknown key: "TAB"`, a failed step and
 * a round trip for a capital letter. Each part of a chord is looked up by its
 * lower-case form, "_", "-" and spaces ignored, so "page_down" and "Page Down"
 * are PageDown too; F1–F12 are upper-cased; a single character is left alone,
 * because "a" and "A" are different presses; and a name not in the table is
 * passed through, since Playwright knows more of them than this lists.
 */
export function playwrightKey(key: string): string {
  return key
    .split("+")
    .map((part) => part.trim())
    .map((part) => {
      if (part.length <= 1) return part;
      const plain = part.toLowerCase().replace(/[\s_-]+/g, "");
      if (KEY_NAMES[plain]) return KEY_NAMES[plain];
      const f = /^f(\d{1,2})$/.exec(plain);
      if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return `F${Number(f[1])}`;
      return part;
    })
    .join("+");
}

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

    const key = playwrightKey(String(args.key ?? "").trim());
    if (!key) return err("`key` must be non-empty, e.g. Enter or PageDown.");
    const times = Math.min(20, Math.max(1, asNumber(args.repeat) ?? 1));

    const stop = await allowed(
      ctx,
      "browser_key",
      `press ${key}${times > 1 ? ` ×${times}` : ""}`,
      [`page: ${p.url()}`],
      p.url()
    );
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
