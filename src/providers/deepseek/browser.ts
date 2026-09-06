import * as fs from "node:fs";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { EXTRACT_REPLY as EXTRACT_REPLY_SCRIPT, toMarkdown } from "./extract";
import {
  DEEPSEEK_CHAT_URL,
  TOKEN_KEY,
  USER_KEY,
  accountId,
  deepseekProfileDir,
  isSignedIn,
} from "./session";

/**
 * The browser OnFlip drives DeepSeek with.
 *
 * A persistent context on DeepSeek's own profile — the same directory a real
 * Chrome signed in to. That split is the whole design: the sign-in happens in
 * an ordinary browser with no automation attached, and only afterwards does
 * Playwright open the profile it left behind.
 *
 * It is not a workaround, it is the arrangement that works. Google refuses
 * OAuth from a browser it can tell is embedded or driven, and no amount of
 * fingerprint work changed that — measured, four separate ways. A real Chrome
 * signing in is simply a real Chrome. ChatGPT's driver has always worked this
 * way, which is why signing in there never had the problem the embedded panel
 * did.
 *
 * `pickSignInBrowser` is borrowed from the ChatGPT driver deliberately rather
 * than copied: finding Chrome or Edge on a machine has nothing to do with
 * which service is being driven. It belongs in a shared place, and will move
 * there once there is a second caller to prove the shape.
 */

/** Where an assistant reply lives; user messages have no markdown node. */
const ASSISTANT_SELECTOR = ".ds-markdown.ds-assistant-message-main-content";

let context: BrowserContext | null = null;

/** The channel to drive with, preferring a real Chrome over the bundled build. */
function executable(): string | undefined {
  const pick = pickSignInBrowser();
  if (pick && pick.channel !== "chromium" && fs.existsSync(pick.executable)) return pick.executable;
  return undefined;
}

export interface OpenOptions {
  /** Show the window. Off by default; the agent's work is not a spectacle. */
  headed?: boolean;
}

export async function openBrowser(opts: OpenOptions = {}): Promise<BrowserContext> {
  if (context) return context;
  const dir = deepseekProfileDir();
  fs.mkdirSync(dir, { recursive: true });
  logger.info("deepseek", "opening the browser", { profile: dir, headed: Boolean(opts.headed) });
  context = await chromium.launchPersistentContext(dir, {
    executablePath: executable(),
    headless: !opts.headed,
    viewport: null,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  context.on("close", () => {
    context = null;
  });
  return context;
}

export async function closeBrowser(): Promise<void> {
  const open = context;
  context = null;
  if (!open) return;
  try {
    await open.close();
  } catch {
    /* already gone */
  }
}

/** The page to work in, on DeepSeek, created if the context has none. */
export async function chatPage(opts: OpenOptions = {}): Promise<Page> {
  const ctx = await openBrowser(opts);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith(DEEPSEEK_CHAT_URL)) {
    await page.goto(DEEPSEEK_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return page;
}

/** Read the session out of a page's localStorage. */
export async function readStorage(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(
    ([tokenKey, userKey]) => ({
      [tokenKey]: localStorage.getItem(tokenKey),
      [userKey]: localStorage.getItem(userKey),
    }),
    [TOKEN_KEY, USER_KEY]
  );
}

export interface SignedInCheck {
  signedIn: boolean;
  account?: string;
}

/**
 * Does the profile hold a usable session?
 *
 * Opens the profile rather than trusting a file on disk: the token is in a
 * LevelDB that is locked while any browser has the profile open, and reading
 * it any other way is guesswork about a format nobody promised.
 */
export async function checkSignedIn(opts: OpenOptions = {}): Promise<SignedInCheck> {
  try {
    const page = await chatPage(opts);
    // The app writes its session after the first paint, so a check the
    // instant the document exists can read an empty store on a good profile.
    await page.waitForTimeout(2_500);
    const storage = await readStorage(page);
    const ok = isSignedIn(storage);
    logger.info("deepseek", "checked the session", { signedIn: ok });
    return { signedIn: ok, account: accountId(storage) ?? undefined };
  } catch (e) {
    logger.warn("deepseek", "could not check the session", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { signedIn: false };
  }
}

/**
 * Send a turn and wait for the answer.
 *
 * Completion is decided by the reply going quiet rather than by a stop
 * button: DeepSeek's controls carry no aria-label and their class names are
 * hashed, so a selector for the stop control is a selector that breaks on the
 * next deploy. Text that has not changed for three consecutive polls is the
 * signal, which costs a second or so at the end of every turn and does not
 * depend on any class name at all.
 *
 * The composer is filled through the value setter and an input event, not by
 * typing: a twenty-thousand-character system prompt typed key by key takes
 * minutes, and this arrives in one go. Measured on the real composer, which
 * accepted 20,936 characters without truncating.
 */
export interface SendResult {
  reply: string;
  /** How long the answer took to settle, for the log. */
  ms: number;
}

const COMPOSER = "textarea";
const SETTLE_POLLS = 3;
const POLL_MS = 1_200;

export async function sendTurn(
  text: string,
  opts: OpenOptions & { timeoutMs?: number } = {}
): Promise<SendResult> {
  const started = Date.now();
  let page = await chatPage(opts);
  const before = await page.$$eval(ASSISTANT_SELECTOR, (els) => els.length).catch(() => 0);

  await page.click(COMPOSER);
  // A string rather than a callback: this package is built without the DOM
  // library, so nothing here may name `document`. The same reason the
  // extractor is a script.
  const fill = `(() => {
    const el = document.querySelector(${JSON.stringify(COMPOSER)});
    if (!el) return -1;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value.length;
  })()`;
  const accepted = (await page.evaluate(fill)) as number;
  if (accepted < 0) throw new Error("DeepSeek's composer was not on the page.");
  if (accepted < text.length) {
    logger.warn("deepseek", "the composer truncated the turn", {
      sent: text.length,
      accepted,
    });
  }
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");

  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let last: string | null = null;
  let quiet = 0;
  let recovered = false;
  while (Date.now() < deadline) {
    try {
      await page.waitForTimeout(POLL_MS);
      const count = await page.$$eval(ASSISTANT_SELECTOR, (els) => els.length).catch(() => 0);
      if (count <= before) continue;
      const now = await page.evaluate(EXTRACT_REPLY_SCRIPT).catch(() => null);
      const text = now ? toMarkdown(now as never) : "";
      if (!text) continue;
      if (text === last) quiet++;
      else quiet = 0;
      last = text;
      if (quiet >= SETTLE_POLLS) break;
    } catch (e) {
      // A renderer that died mid-answer, seen once on a long conversation.
      // The turn was already sent, so this reopens and reads rather than
      // sending again — a resend would ask the model the same thing twice and
      // run whatever it answered twice with it.
      const message = e instanceof Error ? e.message : String(e);
      if (recovered || !/crash|Target closed|Session closed|has been closed/i.test(message)) throw e;
      recovered = true;
      logger.warn("deepseek", "the page died mid-answer; reopening to read the reply", {
        error: message.slice(0, 120),
      });
      await closeBrowser();
      page = await chatPage(opts);
      await page.waitForTimeout(4_000);
      quiet = 0;
    }
  }
  if (last === null) throw new Error("DeepSeek did not answer before the deadline.");
  const ms = Date.now() - started;
  logger.info("deepseek", "turn answered", { chars: last.length, ms });
  return { reply: last, ms };
}
