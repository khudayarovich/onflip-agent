import * as fs from "node:fs";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
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
