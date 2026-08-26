import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { SessionCookie } from "../auth/access";
import { normalizeModel, thinkingDirective } from "../models";
import { configDir } from "../config";
import { logger, shapeOf } from "../log";

/**
 * Drives a real ChatGPT web session through Playwright.
 *
 * This is the primary transport: the backend API path needs an access token
 * that Cloudflare frequently refuses to issue, whereas a logged-in browser
 * session keeps working. The cost is that everything here is DOM-shaped and
 * therefore defensive — selectors are tried in order and completion is
 * detected several independent ways.
 */

const CHAT_URL = "https://chatgpt.com";
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "div[contenteditable='true'][id='prompt-textarea']",
  "textarea[data-id='root']",
  "div.ProseMirror[contenteditable='true']",
  "form textarea",
];
/**
 * Where an assistant reply lives on the page.
 *
 * Every one of these has to be unable to match the *user's* turn. The
 * looser ones used to match any conversation turn's `.markdown`, so before
 * the assistant had rendered a word the newest turn was the message OnFlip
 * had just sent — and it was read back and parsed as a reply.
 */
const ASSISTANT_SELECTORS = [
  "[data-message-author-role='assistant']",
  "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
  ".agent-turn [data-message-author-role='assistant']",
  ".agent-turn .markdown",
];
const STOP_SELECTORS = [
  "button[data-testid='stop-button']",
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
];
const SEND_SELECTORS = [
  "button[data-testid='send-button']",
  "button[data-testid='composer-send-button']",
  "button[aria-label*='Send']",
];

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
/** One conversation is reused per session; reset() forces a fresh one. */
let inConversation = false;
/** How many assistant turns existed before the current send. */
let priorTurnCount = 0;

export interface BrowserOptions {
  /** Show the browser window. Useful for first login and for debugging. */
  headed?: boolean;
  /** Reuse a profile directory so logins and Cloudflare clearance persist. */
  persistProfile?: boolean;
}

let browserOptions: BrowserOptions = {};

/** Set when the composer mangled a message; surfaced once, then cleared. */
let lastComposerWarning: string | null = null;

export function takeComposerWarning(): string | null {
  const w = lastComposerWarning;
  lastComposerWarning = null;
  return w;
}

export function configureBrowser(opts: BrowserOptions): void {
  browserOptions = { ...browserOptions, ...opts };
}

function profileDir(): string {
  const dir = path.join(configDir(), "browser-profile");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Cookies that belong to the browser that earned them, not to the session.
 *
 * Three kinds, all carried in with the login and all wrong to replay:
 *
 *  - Cloudflare's clearance and bot-management cookies are bound to one
 *    browser and address, so another's is useless and looks like the exact
 *    thing an anti-bot check watches for;
 *  - the edge cookies pin a backend that has nothing to do with us;
 *  - the model-config cookies carry the *other* browser's last-used model,
 *    and ChatGPT honours them over the `?model=` OnFlip asks for — which is
 *    how a session set to one model answered as another, unfixable by
 *    /model because the preference was arriving with the cookies.
 */
const NOT_OURS_TO_REPLAY =
  /^(cf_clearance|__cf_bm|__cflb|_cfuvid|GCLB|__oailb|oai-last-model-config|oai-default-model-config)$/i;

function toPlaywrightCookies(cookies: SessionCookie[]) {
  const out: {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "None" | "Lax" | "Strict";
  }[] = [];
  const carried = cookies.filter((c) => !NOT_OURS_TO_REPLAY.test(c.name));
  const dropped = cookies.length - carried.length;
  if (dropped > 0) {
    logger.debug("browser", "left the other browser's edge cookies behind", {
      dropped,
      carried: carried.length,
    });
  }

  for (const c of carried) {
    for (const domain of [".chatgpt.com", ".openai.com"]) {
      out.push({
        name: c.name,
        value: c.value,
        domain,
        path: "/",
        httpOnly: c.name.startsWith("__Secure-") || c.name.startsWith("__Host-"),
        secure: true,
        sameSite: "Lax",
      });
    }
  }
  return out;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Prefer the real installed Chrome over Playwright's bundled Chromium.
 *
 * Cloudflare challenges the bundled build, and its challenge cannot be
 * completed by hand — which breaks signing in precisely when someone needs
 * to. Chrome is the same engine wearing a fingerprint the internet already
 * trusts. When it is not installed, the bundled build still works for
 * everything except the challenge.
 */
/** Is this failure the profile being held by another browser? */
function isProfileInUse(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /ProcessSingleton|profile.*in use|SingletonLock|already running/i.test(m);
}

async function launchWithFallback<T>(
  launch: (channel?: string) => Promise<T>
): Promise<T> {
  const preferred = process.env.ONFLIP_BROWSER_CHANNEL ?? "chrome";
  if (preferred !== "chromium") {
    try {
      const result = await launch(preferred);
      logger.debug("browser", "launched", { channel: preferred });
      return result;
    } catch (e) {
      // A held profile fails identically on the bundled build, so retrying
      // there only starts a second browser before failing again.
      if (isProfileInUse(e)) {
        throw new ChatGPTBrowserError(
          "OnFlip's browser profile is already open — another OnFlip is running, or one did not shut down cleanly. Close it, or end any leftover browser using ~/.onflip/browser-profile, then try again."
        );
      }
      logger.debug("browser", "channel unavailable, using bundled chromium", {
        channel: preferred,
        error: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
    }
  }
  try {
    return await launch(undefined);
  } catch (e) {
    if (isProfileInUse(e)) {
      throw new ChatGPTBrowserError(
        "OnFlip's browser profile is already open — another OnFlip is running, or one did not shut down cleanly. Close it, or end any leftover browser using ~/.onflip/browser-profile, then try again."
      );
    }
    throw e;
  }
}

async function ensurePage(cookies: SessionCookie[]): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // Diagnostic: a browser relaunching mid-session resets the conversation,
  // which shows up as "it starts a new chat every time".
  logger.debug("browser", "launching a browser", { hadPage: Boolean(page) });

  const headless = !browserOptions.headed;
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const shared = {
    args: launchArgs,
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  if (browserOptions.persistProfile) {
    // A persistent profile keeps Cloudflare clearance and the login between
    // runs, which materially reduces how often a session goes stale.
    context = await launchWithFallback((channel) =>
      chromium.launchPersistentContext(profileDir(), { headless, channel, ...shared })
    );
    browser = null;
  } else {
    browser = await launchWithFallback((channel) =>
      chromium.launch({ headless, channel, args: launchArgs })
    );
    context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  await context.addCookies(toPlaywrightCookies(cookies)).catch(() => {
    // A malformed cookie should not be fatal — the profile may already be
    // logged in on its own.
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  inConversation = false;
  return page;
}

async function firstVisible(p: Page, selectors: string[], timeout: number) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const sel of selectors) {
      const loc = p.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 250 })) return loc;
      } catch {
        /* selector not present yet */
      }
    }
    if (Date.now() > deadline) return null;
    await p.waitForTimeout(250);
  }
}

async function anyVisible(p: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      if (await p.locator(sel).first().isVisible({ timeout: 150 })) return true;
    } catch {
      /* not present */
    }
  }
  return false;
}

export class ChatGPTBrowserError extends Error {}

/**
 * What a signed-out profile looks like from inside the page.
 *
 * `/api/auth/session` answers with an empty object rather than an error, so
 * the absence of a token is the whole signal — and reporting that absence
 * verbatim tells the user nothing they can act on.
 */
const SIGNED_OUT_MESSAGE =
  "No ChatGPT session. Sign in to ChatGPT in your normal browser (Chrome, Edge or Firefox), then run `onflip login` to pick the session up.";

async function assertLoggedIn(p: Page): Promise<void> {
  const url = p.url();
  if (/\/auth\/login|\/auth\/signin|openai\.com\/auth/.test(url)) {
    throw new ChatGPTBrowserError(
      "ChatGPT is asking you to log in — the stored session has expired. Sign in to ChatGPT in your normal browser (Chrome, Edge or Firefox), then run `onflip login` to pick the session up."
    );
  }
  const body = await p.locator("body").innerText().catch(() => "");
  if (/just a moment|checking your browser|verify you are human/i.test(body.slice(0, 400))) {
    throw new ChatGPTBrowserError(
      "Cloudflare is challenging the browser OnFlip drives. It usually clears on its own within a few minutes; if it does not, `onflip logout` then `onflip login` picks up a fresh session from your browser."
    );
  }
}

/**
 * Where a new chat is started.
 *
 * Always the ordinary chat page, even when a project is set. Starting a chat
 * *inside* a project needs a full sign-in that a session read out of someone
 * else's browser does not satisfy; the chat is moved into the project once it
 * exists instead, which needs nothing but the session already in use.
 */
export function newChatUrl(model?: string): string {
  if (model && model !== "auto") return `${CHAT_URL}/?model=${encodeURIComponent(model)}`;
  return `${CHAT_URL}/`;
}

/** One wording for every way a chat can end up outside its project. */
function projectUnavailable(name: string, why: string): string {
  return (
    `This chat could not be filed into your "${name}" project — ${why} — so it is in the main list. ` +
    "The chat itself is fine; only where ChatGPT lists it went wrong."
  );
}

/** Set when a project had to be abandoned; surfaced once, then cleared. */
let lastProjectWarning: string | null = null;
/** Filing is retried every turn, so the complaint about it is not. */
let projectWarningShown = false;

function warnProjectUnavailable(name: string, why: string): void {
  if (projectWarningShown) return;
  projectWarningShown = true;
  lastProjectWarning = projectUnavailable(name, why);
}

export function takeProjectWarning(): string | null {
  const w = lastProjectWarning;
  lastProjectWarning = null;
  return w;
}

async function openNewChat(p: Page, model?: string): Promise<void> {
  await p.goto(newChatUrl(model), {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await assertLoggedIn(p);

  const composer = await firstVisible(p, COMPOSER_SELECTORS, 30_000);
  if (!composer) {
    await assertLoggedIn(p);
    throw new ChatGPTBrowserError(
      "Could not find the ChatGPT message box. The page layout may have changed, or the session may be signed out. Try `onflip login --headed`."
    );
  }
  await p.waitForTimeout(600);
  priorTurnCount = 0;
  filedConversation = null;
  projectWarningShown = false;
  // Taken while the chat is still empty, so whatever the account gains from
  // here is this chat. Only worth a request when there is a project to file
  // into.
  conversationsBeforeChat = activeProject ? await snapshotConversations(p) : null;
  logger.info("browser", "opened a new chat", { url: p.url() });
}

/** The conversation id in a `/c/<id>` URL, when the page is on one. */
function conversationIdFromUrl(url: string): string | null {
  const m = /\/c\/([0-9a-f-]{16,})/i.exec(url);
  return m ? m[1] : null;
}

/** The conversation id, waiting briefly for the SPA to put it in the URL. */
async function waitForConversationId(p: Page, timeout = 8_000): Promise<string | null> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const id = conversationIdFromUrl(p.url());
    if (id) return id;
    if (Date.now() > deadline) return null;
    await p.waitForTimeout(250);
  }
}

/** The account's most recent conversation ids, newest first. */
async function recentConversationIds(p: Page, limit = 20): Promise<string[]> {
  const json = (await backendApi(
    p,
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated`
  )) as { items?: { id?: unknown }[] };
  const out: string[] = [];
  for (const item of json.items ?? []) {
    if (typeof item?.id === "string" && item.id) out.push(item.id);
  }
  return out;
}

/** What the account already had when the current chat was opened. */
let conversationsBeforeChat: Set<string> | null = null;

/**
 * The newest conversation the account has gained since the snapshot.
 *
 * Exported because this is the whole of the reasoning that decides which
 * conversation gets moved into someone's project, and getting it wrong moves
 * the wrong one. No snapshot means no answer — never a guess.
 */
export function newestUnseen(recent: string[], before: Set<string> | null): string | null {
  if (!before) return null;
  return recent.find((id) => !before.has(id)) ?? null;
}

async function snapshotConversations(p: Page): Promise<Set<string> | null> {
  try {
    return new Set(await recentConversationIds(p));
  } catch (e) {
    // Best effort. Without it a chat whose id the URL withholds cannot be
    // identified, which costs the filing — not the turn.
    logger.warn("browser", "could not snapshot the conversation list", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Which conversation this page is in.
 *
 * The URL is the cheap answer and not a dependable one: over twenty-five
 * chats in the logs, seven never showed `/c/<id>` at all — and every one of
 * those went unfiled, in a session that reported filing them. So when the URL
 * will not say, the chat is identified as the one the account has gained
 * since it was opened, which is exact and needs nothing from the page.
 */
async function resolveConversationId(p: Page): Promise<string | null> {
  // The URL is the free answer, so it gets a moment — a longer one when
  // there is no snapshot behind it, because then it is the only answer
  // there is.
  const fromUrl = await waitForConversationId(p, conversationsBeforeChat ? 4_000 : 8_000);
  if (fromUrl) return fromUrl;

  // With no snapshot there is nothing to tell this chat from an older one,
  // and moving somebody else's conversation into a project is a good deal
  // worse than leaving this one out of it.
  const before = conversationsBeforeChat;
  if (!before) return null;
  try {
    const fresh = newestUnseen(await recentConversationIds(p), before);
    if (fresh) {
      logger.info("browser", "identified the chat from the conversation list", {
        conversation: fresh,
      });
      return fresh;
    }
  } catch (e) {
    logger.warn("browser", "could not read the conversation list", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

/** Conversations already filed, so a multi-turn chat is only moved once. */
let filedConversation: string | null = null;

/**
 * Move a conversation into a project.
 *
 * This is how the sidebar grouping actually happens: the chat is created on
 * the ordinary page and moved afterwards, because the project page itself is
 * behind a sign-in a transplanted session cannot pass.
 */
async function fileIntoProject(p: Page, conversationId: string, project: RemoteProject): Promise<void> {
  try {
    // `gizmo_id` is the field that moves it. `conversation_template_id` is
    // accepted with a 200 and silently ignored — which is how this reported
    // success for every chat while leaving them all outside the project.
    await backendApi(p, `/backend-api/conversation/${conversationId}`, {
      method: "PATCH",
      body: { gizmo_id: project.id },
    });

    // Trust the read, not the status code.
    const after = (await backendApi(p, `/backend-api/conversation/${conversationId}`)) as {
      gizmo_id?: string | null;
    };
    if (after?.gizmo_id !== project.id) {
      throw new Error(`the chat is still outside the project (gizmo_id: ${after?.gizmo_id ?? "null"})`);
    }

    filedConversation = conversationId;
    logger.info("browser", "filed chat into project", {
      conversation: conversationId,
      project: project.id,
    });
  } catch (e) {
    // The chat itself is fine; only where it is listed went wrong.
    logger.warn("browser", "could not file chat into project", {
      conversation: conversationId,
      project: project.id,
      error: e instanceof Error ? e.message : String(e),
    });
    warnProjectUnavailable(project.name, e instanceof Error ? e.message : String(e));
  }
}

/**
 * File the current chat into the active project, and say which chat it was.
 *
 * The id comes back whether or not the filing worked, because the log wants
 * it either way; null is this turn admitting it does not know where it
 * landed. Retried every turn until it sticks — a chat sitting in the main
 * list is the entire complaint the project setting exists to answer.
 */
async function groupInProject(p: Page): Promise<string | null> {
  if (!activeProject) return conversationIdFromUrl(p.url());
  if (filedConversation) return filedConversation;

  try {
    const conversationId = await resolveConversationId(p);
    if (!conversationId) {
      logger.warn("browser", "could not tell which conversation this is", {
        url: p.url(),
        project: activeProject.id,
      });
      warnProjectUnavailable(
        activeProject.name,
        "ChatGPT never said which conversation this is"
      );
      return null;
    }
    await fileIntoProject(p, conversationId, activeProject);
    return conversationId;
  } catch (e) {
    // The reply is already in hand. Where the chat is listed must never be
    // able to take a completed turn down with it.
    logger.warn("browser", "filing the chat into its project failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
/**
 * Exposed for tests: filing a chat into a project is the part with the
 * interesting behaviour, and it only happens inside a full send.
 */
export async function __sendForTest(
  p: Page,
  message: string,
  opts: BrowserSendOptions
): Promise<string> {
  inConversation = true;
  return sendOn(p, message, opts);
}

export function __resetFiledForTest(): void {
  filedConversation = null;
  conversationsBeforeChat = null;
}

/** Dispatch a real paste event, which is how ProseMirror best accepts text. */
const PASTE_INTO = `(el, text) => {
  el.focus();
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const ev = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  return el.dispatchEvent(ev);
}`;

/**
 * Did the composer receive what we meant to send?
 *
 * Line count is checked, not just characters. Newlines are the fragile part —
 * the composer treats Enter as "send", so a method that turns them into key
 * presses either loses them or fires the message early. A payload that arrives
 * with its newlines flattened still *looks* complete by character count, and
 * the model then receives the entire system prompt as one run-on line.
 */
interface ComposerCheck {
  /** The characters all arrived — safe to send. */
  intact: boolean;
  /** The line structure survived too — ideal. */
  linesKept: boolean;
  wantLines: number;
  gotLines: number;
}

function inspectComposer(typed: string, intended: string): ComposerCheck {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const chars = squash(typed).length / Math.max(1, squash(intended).length);

  const wantLines = intended.split("\n").filter((l) => l.trim()).length;
  const gotLines = typed.split("\n").filter((l) => l.trim()).length;

  return {
    intact: chars >= 0.95,
    // Some composers merge trailing blank lines; a small shortfall is fine, a
    // collapse to a single line is not.
    linesKept: wantLines <= 1 || gotLines >= Math.max(2, Math.floor(wantLines * 0.8)),
    wantLines,
    gotLines,
  };
}

/**
 * Wait until the composer will actually accept typing.
 *
 * Visible is not the same as ready. In the seconds after a reply lands the box
 * is still visible but not yet editable, and a click on it is swallowed — so
 * `insertText`, which types into whatever holds focus, goes nowhere and the
 * send fails with "0 of N lines arrived". That failed on the first attempt of
 * every turn after the first and succeeded on the retry two seconds later,
 * which is the signature of a readiness problem rather than a layout one.
 */
async function waitForComposerReady(p: Page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let composer = await firstVisible(p, COMPOSER_SELECTORS, timeout);
  for (;;) {
    if (composer) {
      const editable = await composer.isEditable({ timeout: 500 }).catch(() => false);
      // Still streaming means the box is about to change state under us.
      const busy = await anyVisible(p, STOP_SELECTORS).catch(() => false);
      if (editable && !busy) return composer;
    }
    if (Date.now() > deadline) return composer;
    await p.waitForTimeout(250);
    composer = await firstVisible(p, COMPOSER_SELECTORS, 1_000);
  }
}

async function typeMessage(p: Page, text: string): Promise<void> {
  const composer = await waitForComposerReady(p);
  if (!composer) {
    throw new ChatGPTBrowserError("The ChatGPT message box disappeared before the message could be sent.");
  }

  /**
   * Empty the box and leave the caret in it.
   *
   * Focus is verified rather than assumed: `insertText` goes to whatever is
   * focused, so a swallowed click silently sends the whole payload into the
   * page body. Clicking is tried first because it is what a person does and it
   * settles ProseMirror's own state, with `focus()` as the fallback.
   */
  const clear = async (): Promise<boolean> => {
    await composer.click({ timeout: 5_000 }).catch(() => {});
    if (!(await composerFocused(p))) {
      await composer.focus({ timeout: 2_000 }).catch(() => {});
    }
    if (!(await composerFocused(p))) return false;
    await p.keyboard.press("Control+A").catch(() => {});
    await p.keyboard.press("Delete").catch(() => {});
    return true;
  };

  // Ordered by what actually works. `insertText` goes through CDP and has
  // preserved every line of every payload in practice; the synthetic paste
  // event is kept as a fallback because ProseMirror handles real pastes well,
  // but it is not what the live composer responds to, so it goes second.
  const strategies: { name: string; run: () => Promise<unknown> }[] = [
    { name: "insertText", run: () => p.keyboard.insertText(text) },
    { name: "paste", run: () => composer.evaluate(PASTE_INTO, text) },
    { name: "fill", run: () => composer.fill(text, { timeout: 8_000 }) },
  ];

  // Keep the best attempt rather than failing on the first imperfect one.
  let best: { check: ComposerCheck; text: string } | null = null;

  // Two full rounds. A round can fail for reasons that pass on their own — the
  // box not yet editable, focus still settling — and burning a whole transport
  // attempt (and its two-second backoff) on that is what the user was seeing.
  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      logger.debug("browser", "composer not ready, retrying", { round });
      await p.waitForTimeout(600);
      await waitForComposerReady(p, 8_000);
    }

    for (const strategy of strategies) {
      const focused = await clear();
      if (!focused && strategy.name === "insertText") {
        // Typing without focus lands somewhere else entirely; skip to a
        // strategy that addresses the element directly.
        logger.debug("browser", "composer would not take focus", { strategy: strategy.name });
        continue;
      }
      try {
        await strategy.run();
      } catch {
        continue;
      }
      await p.waitForTimeout(150);
      const seen = await readComposer(p);
      const check = inspectComposer(seen, text);
      logger.debug("browser", `composer via ${strategy.name}`, {
        strategy: strategy.name,
        round,
        intact: check.intact,
        linesKept: check.linesKept,
        wantLines: check.wantLines,
        gotLines: check.gotLines,
      });

      // Perfect: characters and line structure both survived.
      if (check.intact && check.linesKept) return;
      if (!best || (check.intact && !best.check.intact)) best = { check, text: seen };
    }

    if (best?.check.intact) break;
  }

  // Losing the line structure is survivable — the reply parser can recover a
  // flattened block — so only a genuine loss of content is worth failing on.
  if (best?.check.intact) {
    if (!best.check.linesKept) {
      lastComposerWarning = `The composer flattened the message (${best.check.wantLines} lines in, ${best.check.gotLines} out). Replies may come back malformed.`;
    }
    return;
  }

  throw new ChatGPTBrowserError(
    `The message could not be entered into the ChatGPT composer (${best?.check.gotLines ?? 0} of ${best?.check.wantLines ?? 0} lines arrived). The page layout may have changed — run \`onflip login --headed\` to watch what happens.`
  );
}

const IS_COMPOSER_FOCUSED = `(selectors) => {
  const active = document.activeElement;
  if (!active) return false;
  return selectors.some((sel) => {
    try {
      return active.matches(sel) || Boolean(active.closest(sel));
    } catch {
      return false;
    }
  });
}`;

/** How many user turns the conversation shows. */
async function userTurnCount(p: Page): Promise<number> {
  try {
    return await p.locator("[data-message-author-role='user']").count();
  } catch {
    return 0;
  }
}

/** Is the caret actually in the message box? */
async function composerFocused(p: Page): Promise<boolean> {
  try {
    return Boolean(await p.evaluate(IS_COMPOSER_FOCUSED, COMPOSER_SELECTORS));
  } catch {
    return false;
  }
}

async function readComposer(p: Page): Promise<string> {
  for (const sel of COMPOSER_SELECTORS) {
    try {
      const loc = p.locator(sel).first();
      if (!(await loc.isVisible({ timeout: 150 }))) continue;
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
      return tag === "textarea"
        ? await loc.inputValue()
        : ((await loc.innerText()) ?? "");
    } catch {
      /* try the next selector */
    }
  }
  return "";
}

/**
 * Rebuild the Markdown source of a rendered assistant message.
 *
 * `innerText` is not safe here. By the time a reply is in the DOM it has been
 * through a Markdown renderer, and that renderer *consumes* characters: an
 * `$_.Size ... $_.Size` in a shell command becomes an `<em>` and the
 * underscores are gone from the text entirely. Reading innerText hands the
 * agent a command that no longer runs.
 *
 * So the message is walked and re-serialised: code blocks are taken verbatim
 * from their `<code>` element, and the delimiters the renderer swallowed are
 * put back around emphasis and inline code.
 */
export const EXTRACT_MESSAGE = `(el) => {
  const walk = (node) => {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();

    if (tag === "pre") {
      const code = node.querySelector("code");
      const cls = (code && code.className) || "";
      const m = /language-([\\w+#.-]+)/.exec(cls);
      const body = ((code || node).textContent || "").replace(/\\n+$/, "");
      return "\\n\`\`\`" + (m ? m[1] : "") + "\\n" + body + "\\n\`\`\`\\n";
    }
    if (tag === "br") return "\\n";
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "button") return "";

    let inner = "";
    for (const child of node.childNodes) inner += walk(child);

    // Put back the delimiters the Markdown renderer consumed.
    if (tag === "code") return "\`" + inner + "\`";
    if (tag === "em" || tag === "i") return "_" + inner + "_";
    if (tag === "strong" || tag === "b") return "**" + inner + "**";
    if (tag === "li") return "- " + inner + "\\n";
    if (tag === "blockquote") return "> " + inner + "\\n";
    if (/^h[1-6]$/.test(tag)) return "\\n" + "#".repeat(Number(tag[1])) + " " + inner + "\\n";
    if (tag === "p" || tag === "div" || tag === "tr" || tag === "ul" || tag === "ol") {
      return inner + "\\n";
    }
    return inner;
  };
  return walk(el).replace(/\\n{3,}/g, "\\n\\n").trim();
}`;

async function assistantTurns(p: Page): Promise<string[]> {
  for (const sel of ASSISTANT_SELECTORS) {
    try {
      const nodes = await p.locator(sel).all();
      if (nodes.length === 0) continue;
      const texts: string[] = [];
      for (const n of nodes) {
        const text = await n.evaluate(EXTRACT_MESSAGE).catch(() => null);
        // innerText is still the fallback when evaluation fails mid-stream.
        texts.push(
          typeof text === "string" && text
            ? text
            : ((await n.innerText().catch(() => "")) ?? "")
        );
      }
      return texts;
    } catch {
      /* try the next selector */
    }
  }
  return [];
}

export interface BrowserSendOptions {
  model?: string;
  thinking?: string;
  onDelta?: (fullText: string) => void;
  signal?: AbortSignal;
  /** Overall ceiling for one reply, in milliseconds. */
  timeoutMs?: number;
  /**
   * What was just sent. Any candidate reply matching it is the page
   * showing OnFlip its own message rather than the model's answer.
   */
  sent?: string;
}

/**
 * Send the composed message, and confirm it actually went.
 *
 * Pressing Enter and hoping is not enough: with a long multi-line payload the
 * key can be swallowed — leaving the text sitting in the composer while the
 * agent waits for a reply that will never come. The composer emptying is the
 * only trustworthy signal that the message was accepted, so each method is
 * tried and then verified.
 */
async function submitMessage(p: Page): Promise<void> {
  const methods: { name: string; run: () => Promise<void> }[] = [
    {
      // Clicking the real control is the most faithful to what a user does,
      // and Playwright's actionability check surfaces a disabled button.
      name: "send-button",
      run: async () => {
        const button = await firstVisible(p, SEND_SELECTORS, 4_000);
        if (!button) throw new Error("no send button found");
        await button.click({ timeout: 5_000 });
      },
    },
    { name: "enter", run: () => p.keyboard.press("Enter") },
    { name: "meta-enter", run: () => p.keyboard.press("ControlOrMeta+Enter") },
  ];

  for (const method of methods) {
    try {
      await method.run();
    } catch (e) {
      logger.debug("browser", `submit via ${method.name} failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // The composer clears when ChatGPT accepts the message.
    for (let i = 0; i < 12; i++) {
      await p.waitForTimeout(250);
      const remaining = (await readComposer(p).catch(() => "")).trim();
      if (!remaining) {
        logger.info("browser", "submitted", { via: method.name });
        return;
      }
    }
    logger.debug("browser", `submit via ${method.name} left the composer full`);
  }

  throw new ChatGPTBrowserError(
    "The message was typed but ChatGPT would not accept it — neither the send button nor Enter cleared the composer. The account may be rate-limited, or the send control has moved. Run `onflip login --headed` to watch."
  );
}

export async function sendViaBrowser(
  message: string,
  cookies: SessionCookie[],
  opts?: BrowserSendOptions
): Promise<string> {
  const p = await ensurePage(cookies);

  if (!inConversation) {
    await openNewChat(p, normalizeModel(opts?.model));
    inConversation = true;
  }

  return sendOn(p, message, opts);
}

/** Everything after the page is open and pointed at a chat. */
async function sendOn(
  p: Page,
  message: string,
  opts?: BrowserSendOptions
): Promise<string> {
  const directive = thinkingDirective(opts?.thinking);
  const payload = directive ? `${directive}\n\n${message.trim()}` : message.trim();

  logger.info("browser", "sending", shapeOf(payload));
  logger.debug("browser", "outgoing payload", { payload });

  priorTurnCount = (await assistantTurns(p)).length;

  const typedAt = Date.now();
  await typeMessage(p, payload);
  await p.waitForTimeout(200);
  await submitMessage(p);

  const sentAt = Date.now();
  const reply = await waitForReply(p, priorTurnCount, { ...opts, sent: payload });

  // Group it in the sidebar now that the conversation exists.
  const conversationId = await groupInProject(p);

  // Timing belongs in the log: "it hung" and "it took four minutes" are the
  // same picture from the terminal, and they need different fixes.
  logger.info("browser", "reply received", {
    ...shapeOf(reply),
    composeMs: sentAt - typedAt,
    replyMs: Date.now() - sentAt,
    // Which conversation this landed in, and whether it was grouped. `filed`
    // has to mean the move happened: an unknown id compares equal to an
    // unfiled chat, so every skipped filing used to be logged as a success.
    conversation: conversationId,
    project: activeProject?.id ?? null,
    filed: Boolean(conversationId) && filedConversation === conversationId,
  });
  logger.debug("browser", "raw reply", { reply });
  return reply;
}

/** Exported for testing: completion detection is where replies hang. */
/**
 * Status text ChatGPT shows inside the assistant turn while it is still
 * working. It is stable for many seconds at a time, so a completion rule based
 * on "the text stopped changing" will happily accept it as the whole reply.
 */
/**
 * Is this the message we just sent, rather than a reply to it?
 *
 * Compared on squashed whitespace and only over the opening stretch: the
 * page re-wraps what it renders, and a long payload need not match to the
 * last character to be obviously the same message.
 */
export function isEcho(candidate: string, sent: string | undefined): boolean {
  if (!sent) return false;
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const a = squash(candidate);
  const b = squash(sent);
  if (!a || !b) return false;
  // A short reply that happens to repeat a short prompt is a normal answer.
  if (b.length < 120) return false;
  const head = b.slice(0, 200);
  return a.startsWith(head) || b.startsWith(a.slice(0, 200));
}

function looksLikePlaceholder(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  // The optional prefix is the model badge the UI puts in front of its status
  // on some plans — "Pro thinking" is the label, not the answer.
  return /^(pro |auto |instant |[\w.-]*gpt[\w.-]* )?(working|thinking|analy[sz]ing|searching|reading|browsing|reasoning|planning|thought for [\w\s.]+|done thinking)[.…]*$/i.test(t);
}

export async function waitForReply(
  p: Page,
  before: number,
  opts?: BrowserSendOptions
): Promise<string> {
  const timeout = opts?.timeoutMs ?? 600_000;
  const started = Date.now();
  const deadline = started + timeout;
  const pollMs = 400;

  /**
   * Completion is decided by the *text*, not by the page chrome.
   *
   * An earlier version required the stop button to disappear before it would
   * accept a reply. When that button lingers — or a selector as loose as
   * `aria-label*='stop'` matches some other control — the reply is complete and
   * unchanging while the loop still believes it is streaming, and it spins to
   * the deadline. Button state is now only ever used to finish *sooner*.
   */
  const QUIET_MS = 6_000;      // unchanged this long: the reply is done
  const IDLE_QUIET_MS = 1_200; // ...and the composer looks idle: done sooner
  /**
   * No text *and* no sign of life for this long: give up.
   *
   * The "no sign of life" half matters. Reasoning effort buys thinking time
   * before the first token, and on a large rewrite that regularly runs past a
   * minute and a half — a flat no-text deadline cuts the model off mid-thought
   * and reports it as "no reply", which is both wrong and unactionable. While
   * the stop button is up, ChatGPT is working, and only the overall deadline
   * should end that.
   */
  const NO_SIGN_MS = Math.min(90_000, Math.max(2_000, Math.floor(timeout / 4)));

  let text = "";
  let lastLength = -1;
  let lastChangeAt = Date.now();
  let sawGeneration = false;
  let lastSignAt = started;
  let warnedNeverSent = false;
  let warnedEcho = false;
  let sendLanded = false;
  const userTurnsBefore = await userTurnCount(p).catch(() => 0);
  let loggedPlaceholder = "";
  let notedLongThink = false;

  while (Date.now() < deadline) {
    if (opts?.signal?.aborted) {
      await stopGeneration(p);
      throw new ChatGPTBrowserError("Interrupted.");
    }

    await p.waitForTimeout(pollMs);
    const now = Date.now();

    let generating = false;
    try {
      generating = await anyVisible(p, STOP_SELECTORS);
    } catch {
      /* page busy — fall through to the text checks, which do not need it */
    }
    // Our message being in the thread means the send landed, so something
    // is going to come back; only the deadline should end the wait.
    if (!sendLanded) {
      sendLanded = await userTurnCount(p).then((n) => n > userTurnsBefore).catch(() => false);
      if (sendLanded) lastSignAt = now;
    }

    if (generating) {
      sawGeneration = true;
      lastSignAt = now;
    }

    let turns: string[];
    try {
      turns = await assistantTurns(p);
    } catch {
      continue;
    }

    let candidate = text;
    if (turns.length > before) {
      candidate = turns[turns.length - 1] ?? "";
    } else if (turns.length === before && before > 0 && sawGeneration) {
      // Some layouts reuse the last node rather than appending one.
      candidate = turns[turns.length - 1] ?? "";
    }

    // The page showing us our own message is not the model answering it.
    // This happened for real: a fallback selector matched the user's turn,
    // the whole payload came back as the reply, and the protocol examples
    // inside the system prompt were parsed and run as tool calls.
    if (candidate && isEcho(candidate, opts?.sent)) {
      if (!warnedEcho) {
        warnedEcho = true;
        logger.warn("browser", "read our own message back; still waiting", {
          chars: candidate.length,
        });
      }
      continue;
    }
    text = candidate;

    if (text.length !== lastLength) {
      lastLength = text.length;
      lastChangeAt = now;
      if (text) opts?.onDelta?.(text);
      continue;
    }

    const quietFor = now - lastChangeAt;

    // A placeholder while generating is not an answer; keep waiting for the
    // real text rather than returning "Working" as the model's reply.
    const placeholder = generating && looksLikePlaceholder(text);
    if (placeholder && text !== loggedPlaceholder) {
      loggedPlaceholder = text;
      logger.debug("browser", "waiting through placeholder", { text: text.trim() });
    }

    if (text.trim() && !placeholder) {
      // Fast path: the composer is back to idle and the text has settled.
      if (!generating) {
        const sendBack = await anyVisible(p, SEND_SELECTORS).catch(() => false);
        if (sendBack && quietFor >= IDLE_QUIET_MS) {
          logger.debug("browser", "reply complete (composer idle)", { quietFor, chars: text.length });
          return text.trim();
        }
      }
      // Backstop: the text simply stopped growing. This is what guarantees the
      // loop terminates no matter what the page chrome is doing.
      if (quietFor >= QUIET_MS) {
        logger.debug("browser", "reply complete (text settled)", {
          quietFor,
          chars: text.length,
          stillGenerating: generating,
        });
        return text.trim();
      }
      continue;
    }

    // ---- nothing has arrived yet -------------------------------------------
    if (!sawGeneration && !warnedNeverSent && now - started > 20_000) {
      warnedNeverSent = true;
      const composerContent = await readComposer(p).catch(() => "");
      if (composerContent.trim()) {
        throw new ChatGPTBrowserError(
          "The message was typed but never sent — the composer still holds it. ChatGPT may be rate-limiting this account, or the send control has moved."
        );
      }
    }
    // Long silences are normal while it thinks, but they should be visible in
    // the log — "it hung" and "it thought for four minutes" look identical
    // from the terminal.
    if (generating && !notedLongThink && now - started > 60_000) {
      notedLongThink = true;
      logger.info("browser", "still generating, no text yet", {
        elapsedMs: now - started,
        deadlineMs: timeout,
      });
    }
    // Only give up on silence when there is no evidence anything is under
    // way at all. A landed message is evidence.
    if (!sendLanded && now - lastSignAt > NO_SIGN_MS) break;
  }

  // Falling out of the loop with only a placeholder means generation stalled.
  // Returning "Working" as the model's answer would be worse than failing.
  if (text.trim() && !looksLikePlaceholder(text)) return text.trim();
  if (text.trim()) {
    logger.warn("browser", "gave up on placeholder text", { text: text.trim() });
  }
  await assertLoggedIn(p);
  const secs = Math.round((Date.now() - started) / 1000);

  // Two different failures wear the same "no reply" face, and they need
  // different things from the user. Still generating at the deadline is a
  // budget problem; never generating at all is a page or account problem.
  if (sawGeneration) {
    throw new ChatGPTBrowserError(
      `ChatGPT was still working after ${secs}s and the reply budget ran out. Give it longer with \`onflip config replyTimeout ${Math.max(600, secs * 2)}\` (seconds), or lower the reasoning effort with /thinking.`
    );
  }
  throw new ChatGPTBrowserError(
    `No reply from ChatGPT after ${secs}s, and the page never showed it working. The account may be rate-limited, the model may be unavailable, or the reply selectors may no longer match — try \`onflip login --headed\` to watch.`
  );
}

async function stopGeneration(p: Page): Promise<void> {
  for (const sel of STOP_SELECTORS) {
    try {
      const btn = p.locator(sel).first();
      if (await btn.isVisible({ timeout: 200 })) {
        await btn.click({ timeout: 2_000 });
        return;
      }
    } catch {
      /* nothing to stop */
    }
  }
}

/** Forget the current chat so the next message opens a fresh conversation. */
export function resetBrowserChat(): void {
  inConversation = false;
  priorTurnCount = 0;
  filedConversation = null;
  conversationsBeforeChat = null;
  projectWarningShown = false;
}

/** True while a live ChatGPT conversation is open and being appended to. */
export function browserInConversation(): boolean {
  return inConversation && Boolean(page) && !page!.isClosed();
}

export function browserIsOpen(): boolean {
  return Boolean(page && !page.isClosed());
}

/**
 * Read the account's model list from inside the logged-in page.
 *
 * Done as a page-context fetch rather than a Node one so it inherits the
 * session that Cloudflare has already cleared. The bearer token is pulled from
 * the same auth endpoint the web app uses, because `/backend-api/models`
 * requires it and cookies alone are not enough.
 */
export async function fetchModelsViaBrowser(cookies: SessionCookie[]): Promise<Record<string, unknown>> {
  // This used to be its own copy of the session-token dance, complete with the
  // same reference to a Node constant from inside the page. One request path,
  // one place for it to be wrong.
  const p = await pageOnChatGpt(cookies);
  return (await backendApi(p, "/backend-api/models")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// existing ChatGPT conversations
// ---------------------------------------------------------------------------

export interface RemoteConversation {
  id: string;
  title: string;
  /** Epoch millis, or 0 when the backend did not say. */
  updatedAt: number;
  /**
   * The project this chat lives in, or null for the main list. This is the
   * field the web UI groups on, so it is also what decides whether a chat
   * clutters someone's sidebar.
   */
  projectId: string | null;
}

/**
 * List the account's own ChatGPT conversations.
 *
 * Read through the page rather than by a direct request: the same fetch runs
 * from inside the logged-in tab, where the session cookie and Cloudflare
 * clearance already apply, which is the difference between this working and
 * returning 403 on a machine whose access token has gone stale.
 */
/** Read one conversation record; null when it is not one. */
function parseConversation(
  raw: unknown,
  fallbackProjectId: string | null = null
): RemoteConversation | null {
  const item = raw as {
    id?: unknown;
    title?: unknown;
    update_time?: unknown;
    gizmo_id?: unknown;
  };
  const id = typeof item.id === "string" ? item.id : "";
  if (!id) return null;
  const stamp = Date.parse(String(item.update_time ?? ""));
  return {
    id,
    title:
      typeof item.title === "string" && item.title.trim() ? item.title.trim() : "(untitled chat)",
    updatedAt: Number.isFinite(stamp) ? stamp : 0,
    // The project-scoped listing does not repeat the id on every item, so the
    // project being asked about stands in for it.
    projectId:
      typeof item.gizmo_id === "string" && item.gizmo_id ? item.gizmo_id : fallbackProjectId,
  };
}

/** The page, parked on ChatGPT and known to be logged in. */
async function pageOnChatGpt(cookies: SessionCookie[]): Promise<Page> {
  const p = await ensurePage(cookies);
  if (!/chatgpt.com/.test(p.url())) {
    await p.goto(`${CHAT_URL}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await assertLoggedIn(p);
  return p;
}

/**
 * List the account's own ChatGPT conversations.
 *
 * Read through the page rather than by a direct request: the same fetch runs
 * from inside the logged-in tab, where the session cookie and Cloudflare
 * clearance already apply, which is the difference between this working and
 * returning 403 on a machine whose access token has gone stale.
 */
export async function listConversations(
  cookies: SessionCookie[],
  limit = 40
): Promise<RemoteConversation[]> {
  const p = await pageOnChatGpt(cookies);
  const json = (await backendApi(
    p,
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated`
  )) as { items?: unknown[] };

  const out: RemoteConversation[] = [];
  for (const raw of json.items ?? []) {
    const conversation = parseConversation(raw);
    if (conversation) out.push(conversation);
  }
  return out;
}

/**
 * List only the conversations inside one project.
 *
 * Asked of the project directly rather than filtered out of the main listing:
 * that one is capped and ordered by recency, so a project whose chats are
 * older than the newest few dozen would come back looking empty.
 */
export async function listProjectConversations(
  cookies: SessionCookie[],
  projectId: string,
  limit = 40
): Promise<RemoteConversation[]> {
  const p = await pageOnChatGpt(cookies);
  const json = (await backendApi(
    p,
    `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?limit=${limit}`
  )) as { items?: unknown[] };

  const out: RemoteConversation[] = [];
  for (const raw of json.items ?? []) {
    const conversation = parseConversation(raw, projectId);
    if (conversation) out.push(conversation);
  }
  return out;
}
/** One message already in a ChatGPT thread. */
export interface RemoteMessage {
  role: "user" | "assistant";
  content: string;
}


/**
 * Wait for a conversation's turns to finish mounting.
 *
 * `domcontentloaded` fires long before the thread is rendered, and a fixed
 * pause guesses wrong in both directions: a live attach found *zero* messages
 * after 1.2 seconds, while a long thread mounts progressively and would be
 * read half-finished. So poll until the count stops growing, and accept an
 * empty thread only once the page has had a fair chance.
 */
async function settleTurns(p: Page, timeout = 15_000): Promise<number> {
  const deadline = Date.now() + timeout;
  let count = 0;
  let stableFor = 0;

  while (Date.now() < deadline) {
    await p.waitForTimeout(300);
    let seen = 0;
    try {
      seen = await p.locator("[data-message-author-role]").count();
    } catch {
      continue;
    }
    if (seen !== count) {
      count = seen;
      stableFor = 0;
      continue;
    }
    if (count === 0) continue;
    stableFor += 300;
    if (stableFor >= 900) return count;
  }
  return count;
}

/**
 * Attach to an existing ChatGPT conversation and read what is already in it.
 *
 * The thread keeps its own context on ChatGPT's side, which is the whole
 * reason continuing one works at all — but the visible turns are pulled back
 * anyway so the transcript, `/export` and a later replay into a fresh thread
 * all have something real to work from.
 */
export async function openConversation(
  cookies: SessionCookie[],
  id: string
): Promise<RemoteMessage[]> {
  const target = `${CHAT_URL}/c/${encodeURIComponent(id)}`;

  // Opening a conversation works on a page's *first* navigation and bounces
  // back to a new chat on every one after it — whichever conversation, in
  // whichever order. Something in the loaded app takes over routing, so the
  // fix is not a smarter navigation but a page that has not been used yet.
  // The retry therefore throws the browser away and starts again, which is
  // slow enough to be worth avoiding and reliable enough to be worth doing.
  let p = await ensurePage(cookies);
  // Spend a throwaway page on establishing the session first. A page that
  // navigates before the app has one bounces straight back to a new chat,
  // which is indistinguishable from the conversation not existing.
  const signedIn = await warmSession();
  let turnCount = 0;
  let landed = false;
  for (let attempt = 0; attempt < 2 && !landed; attempt++) {
    if (attempt > 0) {
      logger.debug("browser", "reopening the browser for a clean navigation", { id });
      await closeBrowser();
      p = await ensurePage(cookies);
    }
    await p.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await assertLoggedIn(p);

    const composer = await firstVisible(p, COMPOSER_SELECTORS, 30_000);
    if (!composer) {
      throw new ChatGPTBrowserError(
        "That conversation opened but its message box never appeared. It may have been deleted, or the page layout may have changed."
      );
    }

    turnCount = await settleTurns(p);
    landed = turnCount > 0 && p.url().includes(id);
    if (!landed) {
      logger.debug("browser", "conversation did not stick", {
        id,
        url: p.url(),
        turns: turnCount,
        attempt: attempt + 1,
      });
    }
  }

  if (!landed) {
    inConversation = false;
    logger.warn("browser", "conversation would not open", {
      id,
      url: p.url(),
      turns: turnCount,
      signedIn,
    });
    // The two things this failure can mean need different things done about
    // them, and telling someone their conversation may have been deleted when
    // the session simply was not ready sends them to look in the one place
    // the answer is not.
    throw new ChatGPTBrowserError(
      signedIn
        ? "ChatGPT would not open that conversation — the page kept returning to a new chat. It may have been deleted, or it may belong to another account."
        : "ChatGPT would not open that conversation: the browser session was not ready. Try again — if it keeps happening, `onflip login` picks up a fresh session."
    );
  }
  // The role is read off each node directly. An earlier version collected them
  // in one `page.evaluate` of a stringified function — but a string with no
  // argument is evaluated as an *expression*, so it returned the function
  // rather than calling it, and every attach silently imported nothing.
  const messages: RemoteMessage[] = [];
  const nodes = await p.locator("[data-message-author-role]").all().catch(() => []);
  for (const node of nodes) {
    try {
      const role = await node.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") continue;
      const text = await node.evaluate(EXTRACT_MESSAGE).catch(() => null);
      const content =
        typeof text === "string" && text ? text : ((await node.innerText().catch(() => "")) ?? "");
      if (content.trim()) messages.push({ role, content: content.trim() });
    } catch {
      // A turn we cannot read is skipped rather than failing the attach; the
      // server-side context is what actually continues the conversation.
    }
  }

  inConversation = true;
  priorTurnCount = (await assistantTurns(p)).length;
  logger.info("browser", "attached to conversation", {
    id,
    messages: messages.length,
    assistantTurns: priorTurnCount,
  });
  return messages;
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export interface RemoteProject {
  id: string;
  /** The `g-p-…-name` form. Only this one renders a composer. */
  shortUrl: string;
  name: string;
}

/** Where new chats are started, when the user has chosen a project. */
let activeProject: RemoteProject | null = null;

export function setActiveProject(project: RemoteProject | null): void {
  activeProject = project;
}

export function getActiveProject(): RemoteProject | null {
  return activeProject;
}

/**
 * The page's own access token, waited for rather than sampled once.
 *
 * `/api/auth/session` answers 200 with an empty body while the app is still
 * settling, and an empty body is not the same thing as being signed out.
 * Measured on a working account: the first call or two after a browser launch
 * come back with nothing and the one after that carries a token — which is
 * why `/chats` needed two or three goes before it worked, and why restarting
 * the CLI appeared to fix it.
 *
 * Runs from Node so it can wait and retry. Reading it inside the page, as the
 * requests below used to, means one sample and no second chance.
 *
 * Exported for tests: the retry is the whole fix, and it only shows itself
 * against a page that answers empty before it answers properly.
 */
export async function pageAccessToken(p: Page, attempts = 5): Promise<string> {
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = (await p.evaluate(async () => {
      try {
        const res = await fetch("/api/auth/session", { credentials: "include" });
        if (!res.ok) return { token: "", detail: `HTTP ${res.status}` };
        const json = (await res.json()) as { accessToken?: string };
        return { token: json.accessToken ?? "", detail: json.accessToken ? "" : "no token in the session" };
      } catch (e) {
        return { token: "", detail: String(e).slice(0, 140) };
      }
    })) as { token: string; detail: string };

    if (result.token) {
      if (attempt > 1) logger.debug("browser", "access token arrived late", { attempt });
      return result.token;
    }
    detail = result.detail;
    if (attempt === attempts) break;

    await p.waitForTimeout(400 * attempt);
    // Two different failures need two different remedies: a slow start wants
    // the wait above, a page that loaded before its cookies were in place
    // wants a reload. Do one of each rather than guessing which it is.
    if (attempt === 2) {
      await p.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await assertLoggedIn(p).catch(() => {});
    }
  }
  logger.warn("browser", "the page never produced an access token", { attempts, detail });
  return "";
}

/**
 * Establish the session on a throwaway page.
 *
 * A conversation only opens on a page's *first* navigation, so the session
 * cannot be checked on that page beforehand — checking it means navigating,
 * and that navigation is the one good one. A second page in the same context
 * shares the cookies and warms the same session, leaving the real page
 * pristine for the conversation itself.
 */
async function warmSession(): Promise<boolean> {
  if (!context) return false;
  const scratch = await context.newPage().catch(() => null);
  if (!scratch) return false;
  try {
    await scratch.goto(`${CHAT_URL}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return Boolean(await pageAccessToken(scratch));
  } catch (e) {
    logger.debug("browser", "could not warm the session", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  } finally {
    await scratch.close().catch(() => {});
  }
}

/**
 * Run a `/backend-api` request from inside the logged-in page.
 *
 * The page already holds the session cookie and Cloudflare clearance, so the
 * same request that gets a 403 from Node succeeds from here.
 */
async function backendApi(
  p: Page,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  // Fetched out here, where an empty answer can be waited out. It also has to
  // be: the page has no access to this module's constants, so the signed-out
  // message it used to return by name was a ReferenceError that masked every
  // real diagnosis with a stack trace.
  const token = await pageAccessToken(p);
  if (!token) throw new ChatGPTBrowserError(SIGNED_OUT_MESSAGE);

  const result = await p.evaluate(
    async (args: { path: string; method: string; body: string | null; token: string }) => {
      const fail = (stage: string, detail: string) => ({ __error: `${stage}: ${detail}` });
      try {
        const res = await fetch(args.path, {
          method: args.method,
          credentials: 'include',
          headers: { authorization: 'Bearer ' + args.token, 'content-type': 'application/json' },
          body: args.body ?? undefined,
        });
        const text = await res.text();
        if (!res.ok) return fail('request', `HTTP ${res.status} ${text.slice(0, 200)}`);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return fail('parse', text.slice(0, 200));
        }
      } catch (e) {
        return fail('request', String(e));
      }
    },
    {
      path,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? null : JSON.stringify(init.body),
      token,
    }
  );

  const error = (result as { __error?: string }).__error;
  if (error) throw new ChatGPTBrowserError(error);
  return result;
}

/** Read one project record out of the several shapes the sidebar returns. */
export function parseProject(raw: unknown): RemoteProject | null {
  const item = raw as { gizmo?: unknown };
  const outer = (item?.gizmo ?? raw) as { gizmo?: unknown };
  const g = ((outer?.gizmo ?? outer) ?? {}) as {
    id?: unknown;
    short_url?: unknown;
    display?: { name?: unknown };
  };
  const id = typeof g.id === 'string' ? g.id : '';
  // Projects are the `g-p-` gizmos; plain GPTs share the endpoint.
  if (!id.startsWith('g-p-')) return null;
  const shortUrl = typeof g.short_url === 'string' && g.short_url ? g.short_url : id;
  const name =
    typeof g.display?.name === 'string' && g.display.name.trim()
      ? g.display.name.trim()
      : '(untitled project)';
  return { id, shortUrl, name };
}

/** The account's projects, newest-used first, as the sidebar orders them. */
export async function listProjects(cookies: SessionCookie[]): Promise<RemoteProject[]> {
  const p = await ensurePage(cookies);
  if (!/chatgpt.com/.test(p.url())) {
    await p.goto(`${CHAT_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await assertLoggedIn(p);

  const json = (await backendApi(
    p,
    '/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0'
  )) as { items?: unknown[] };

  const out: RemoteProject[] = [];
  for (const item of json.items ?? []) {
    const project = parseProject(item);
    if (project) out.push(project);
  }
  return out;
}

/** Create a project and return it, ready to be made active. */
export async function createProject(
  cookies: SessionCookie[],
  name: string
): Promise<RemoteProject> {
  const p = await ensurePage(cookies);
  if (!/chatgpt.com/.test(p.url())) {
    await p.goto(`${CHAT_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await assertLoggedIn(p);

  const json = (await backendApi(p, '/backend-api/projects', {
    method: 'POST',
    // `instructions` is required even when empty.
    body: { name, instructions: '' },
  })) as { resource?: unknown };

  const project = parseProject(json.resource ?? json);
  if (!project) {
    throw new ChatGPTBrowserError(
      'ChatGPT accepted the request but did not return a project. Create it on chatgpt.com and pick it with /project.'
    );
  }
  logger.info('browser', 'created project', { id: project.id, name: project.name });
  return project;
}

/**
 * Open the logged-in page and hand it back, for diagnostics only.
 *
 * Exported so a probe can ask the real session questions without this module
 * having to grow a guess-shaped API for every one of them.
 */
export async function debugOpenRoot(cookies: SessionCookie[]): Promise<Page> {
  const p = await ensurePage(cookies);
  if (!/chatgpt.com/.test(p.url())) {
    await p.goto(`${CHAT_URL}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await assertLoggedIn(p);
  await p.waitForTimeout(1_500);
  return p;
}

/**
 * Is the browser profile signed in to ChatGPT?
 *
 * `/api/auth/session` answers 200 with an empty payload when it is not, so
 * a failed request and a signed-out profile look nothing alike — which is
 * why this reports the two separately rather than returning a bare false.
 */
export async function checkSignedIn(
  cookies: SessionCookie[]
): Promise<{ signedIn: boolean; reachable: boolean; detail: string }> {
  try {
    const p = await pageOnChatGpt(cookies);
    // Through the same waiting reader the requests use. Sampling the endpoint
    // once here reported a signed-in account as signed out on startup, which
    // is when the token is least likely to have arrived yet.
    const token = await pageAccessToken(p);
    return {
      signedIn: Boolean(token),
      reachable: true,
      detail: token ? '' : 'the page produced no access token',
    };
  } catch (e) {
    return {
      signedIn: false,
      reachable: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Open a headed window and park on ChatGPT so the user can sign in. */
export async function openLoginWindow(cookies: SessionCookie[]): Promise<void> {
  configureBrowser({ headed: true, persistProfile: true });
  const p = await ensurePage(cookies);
  await p.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

export async function closeBrowser(): Promise<void> {
  try {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  } finally {
    page = null;
    context = null;
    browser = null;
    inConversation = false;
    priorTurnCount = 0;
    filedConversation = null;
    conversationsBeforeChat = null;
    projectWarningShown = false;
  }
}
