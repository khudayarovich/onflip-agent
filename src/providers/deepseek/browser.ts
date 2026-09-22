import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import type { FailureCode } from "../../chatgpt/backoff";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { EXTRACT_REPLY as EXTRACT_REPLY_SCRIPT, toMarkdown } from "./extract";
import {
  DEEPSEEK_CHAT_URL,
  TOKEN_KEY,
  USER_KEY,
  deepseekProfileDir,
  isSignedIn,
} from "./session";
import { mkdirPrivate } from "../../config";
import { releaseProfileLock } from "../profile-lock";

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

/**
 * A DeepSeek failure that knows what it is.
 *
 * The classifier reads a failure's code when it has one and falls back to
 * reading its English sentence when it does not. Nothing in this driver set
 * a code, so every DeepSeek failure was classified by its prose - and the
 * prose hedged. "The page may have signed out, or the send did not land"
 * matched the fatal test for "signed out", so the turn died without a
 * single retry: not a retry that failed, a retry that never happened. Four
 * turns in one week's logs, all of them the common case the hedge names
 * second.
 *
 * That is the third outbreak of one disease, and backoff.ts documents the
 * first two in its own comments: advice text ending in "rate-limited" read
 * back as a throttle, and advice text ending in "run `onflip login`" read
 * back as fatal. A sentence written for a person should not be parsed by a
 * machine. This is how the driver stops asking it to be.
 */
class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly code?: FailureCode
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

/**
 * Open the chat, turning a lost race into something retryable.
 *
 * Playwright says a navigation cancelled by another navigation was
 * "interrupted", and the classifier's fatal test matches that word because
 * it exists to honour a user pressing stop. A page racing itself is the
 * opposite of a user deciding to stop - it is exactly the transient that
 * one more attempt fixes.
 */
async function gotoChat(page: Page): Promise<void> {
  try {
    await page.goto(DEEPSEEK_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/interrupted by another navigation/i.test(message)) {
      throw new DeepSeekError(
        `Loading the DeepSeek chat was interrupted by another navigation. Retrying. (${message})`,
        "send-not-landed"
      );
    }
    throw e;
  }
}

/** Where an assistant reply lives; user messages have no markdown node. */
const ASSISTANT_SELECTOR = ".ds-markdown.ds-assistant-message-main-content";

/**
 * DeepSeek talking, rather than the model answering.
 *
 * "Server busy, please try again later." sat on the page, in English, for
 * the whole ninety seconds OnFlip spent waiting for a reply that was never
 * coming — and then the turn failed with a sentence about the send not
 * landing. It had landed. The conversation was created, the question was
 * in it, and the service had already said why there would be no answer.
 *
 * The same channel carries the rest of it: a rate limit, a verification
 * page, a login wall. None of them are replies, and all of them are
 * readable in a second rather than a minute and a half.
 *
 * Chinese as well as English, because the UI ships in both and an account
 * set to Chinese gets the Chinese wording.
 */
const SERVICE_MESSAGES: { pattern: RegExp; code: FailureCode; retryable: boolean }[] = [
  // Overloaded rather than refusing us: worth another attempt, but not
  // worth ninety seconds of silence first.
  {
    pattern: /server (is )?busy|系统繁忙|服务器繁忙|сервер занят|сервер перегружен/i,
    code: "service-error",
    retryable: true,
  },
  // A challenge is for a person to clear. Sending again makes it worse.
  {
    pattern: /one more step before you proceed|verify you are human|checking your browser|just a moment|проверка браузера|подтвердите, что вы человек|минуточку/i,
    code: "refused",
    retryable: false,
  },
  {
    pattern: /rate limit|too many requests|请求过于频繁|слишком много запросов|превышен лимит/i,
    code: "throttled",
    retryable: false,
  },
];

/**
 * The service's own words in a page's text, or null when it is just a page.
 *
 * Pure, so the patterns can be held against real wording without a browser.
 */
export function matchServiceMessage(body: string): { text: string; code: FailureCode } | null {
  if (!body) return null;
  for (const rule of SERVICE_MESSAGES) {
    const hit = rule.pattern.exec(body);
    if (!hit) continue;
    const line =
      body
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .find((l) => rule.pattern.test(l)) ?? hit[0];
    return { text: line, code: rule.code };
  }
  return null;
}

/** The service's own words, when the page is showing some. */
async function serviceMessage(page: Page): Promise<{ text: string; code: FailureCode } | null> {
  const body = (await page
    .evaluate("(document.body && document.body.innerText) || \"\"")
    .catch(() => "")) as string;
  return matchServiceMessage(body);
}
/** Send, and — while an answer is being written — stop. The same control. */
const STOP_BUTTON = ".ds-button--primary";

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
  mkdirPrivate(dir);
  // Chromium allows one process per profile directory and refuses the
  // second outright. On a Mac the sign-in browser is still alive after
  // its window closes, so without this the read that follows a sign-in
  // fails with "Failed to create a ProcessSingleton" - reported as "could
  // not check the session" to somebody who had just signed in.
  await releaseProfileLock(dir, (message, data) => logger.info("deepseek", message, data));
  logger.info("deepseek", "opening the browser", { profile: dir, headed: Boolean(opts.headed) });
  context = await chromium.launchPersistentContext(dir, {
    executablePath: executable(),
    headless: !opts.headed,
    viewport: null,
    args: ["--no-first-run", "--no-default-browser-check"],
    // Shorter than the 90-second default, because failing here is normal and
    // recoverable: the first launch on a profile a real Chrome has just
    // created loses its pipe when Chrome relaunches itself, and the caller
    // retries. Measured — two attempts at the default spent three minutes
    // before answering, which is why signing in on a new machine reported no
    // session and worked on the next start.
    timeout: 30_000,
  });
  const opened = context;
  opened.on("close", () => {
    // Only for the browser this handler belongs to: a replacement may
    // already be open by the time an old one finishes closing.
    if (context !== opened && context !== null) return;
    context = null;
    forgetConversation();
  });
  return context;
}

export async function closeBrowser(): Promise<void> {
  const open = context;
  context = null;
  // The thread went with the browser: a reopened one starts at the chat
  // root, so the next send must carry the whole transcript, not a delta.
  forgetConversation();
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
    await gotoChat(page);
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
  /** A name a person recognises, when the account has one. Never the id. */
  account?: string;
  /** As DeepSeek gives it, which is already masked: `fas*****98@gmail.com`. */
  email?: string;
  /**
   * Why the profile could not be read, when that is what happened.
   *
   * "Not signed in" and "could not look" are different answers, and this
   * check used to give the first for both: a profile still held by a Chrome
   * that had not finished exiting threw, the throw was logged and swallowed,
   * and the user was told there was no session — after signing in. Reported
   * from a new machine, where the sign-in window and the read race hardest.
   */
  error?: string;
}

/**
 * The name on the account, asked of DeepSeek's own endpoint.
 *
 * localStorage holds an id and nothing else — a bare UUID, which is what the
 * sidebar was showing where a name belongs. `/api/v0/users/current` has the
 * rest, behind the same token the page uses, and returns the masked email
 * DeepSeek chooses to show plus the name from whichever identity provider the
 * account was created with.
 *
 * Asked from inside the page so the request carries the session the way the
 * app's own do, and treated as cosmetic throughout: any failure returns
 * nothing and the sidebar falls back to "DeepSeek account". The token is used
 * for the one request and never stored or logged.
 */
/**
 * What DeepSeek itself says about the token in this profile.
 *
 * Three answers, and the third is the one that keeps this honest:
 *
 * - `live`    — the service accepted the token and described the account.
 * - `dead`    — the service refused it. 401 or 403 is DeepSeek saying, in
 *               as many words, that this is not a session.
 * - `unknown` — nobody could ask. Offline, a 5xx, a timeout, a page that
 *               was not ready. Not evidence of anything.
 *
 * This request was already here, and its answer was already being thrown
 * away: it existed to put a name in the sidebar, and every failure — a dead
 * token included — returned the same empty object as a network hiccup. So
 * the one piece of ground truth OnFlip could get about a DeepSeek session
 * was fetched, received, and discarded, while the signed-in decision was
 * made from a string in localStorage.
 *
 * That is the same fault Qwen was shipping for six releases: a token that
 * is present, well-formed and refused. There the remedy had to be inferred
 * from the page's own header, because Qwen offered nothing better. Here the
 * service answers the question directly, and always could.
 *
 * `unknown` deliberately does not mean signed out. Being wrong that way
 * sends somebody to a sign-in they did not need, which is exactly the
 * complaint this whole line of work started from.
 */
export type SessionVerdict = "live" | "dead" | "unknown";

/** What came back from asking DeepSeek, as facts rather than a conclusion. */
export interface SessionAnswer {
  /** HTTP status, or 0 when there was nothing to ask with or nobody answered. */
  status?: number;
  /** Did the request complete at all? False for offline, DNS, a timeout. */
  reached?: boolean;
  /** Did the answer actually describe an account? */
  hasUser?: boolean;
}

/**
 * The rule, kept out of the page so it can be held against every answer.
 *
 * The one case that means signed out is the service refusing the credential.
 * Everything else that goes wrong — offline, a 502, a body that would not
 * parse, a shape that changed — is this code failing to find out, and
 * `unknown` says so. Being wrong in that direction costs a request; being
 * wrong in the other sends somebody to a sign-in they did not need, which is
 * the complaint this entire line of work began with.
 *
 * `status: 0` with `reached: true` is the one odd pair: it means the store
 * had no token to ask with, which is not a service refusal but is certainly
 * not a session either.
 */
export function sessionVerdict(answer: SessionAnswer | null | undefined): SessionVerdict {
  if (!answer || answer.reached !== true) return "unknown";
  const status = answer.status ?? 0;
  if (status === 0) return "dead";
  if (status === 401 || status === 403) return "dead";
  if (status < 200 || status >= 300) return "unknown";
  return answer.hasUser ? "live" : "unknown";
}

async function askDeepSeek(
  page: Page
): Promise<{ verdict: SessionVerdict; name?: string; email?: string }> {
  try {
    const raw = (await Promise.race([
      page.evaluate(`(async () => {
        let token = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) || "";
        try { token = JSON.parse(token).value || token; } catch (e) {}
        if (!token) return { status: 0, reached: true, hasUser: false };
        let res;
        try {
          res = await fetch("/api/v0/users/current", {
            credentials: "include",
            headers: { authorization: "Bearer " + token },
          });
        } catch (e) {
          return { status: 0, reached: false, hasUser: false };
        }
        let user = null;
        try {
          const body = await res.json();
          user = body && body.data && body.data.biz_data;
        } catch (e) { user = null; }
        return {
          status: res.status,
          reached: true,
          hasUser: Boolean(user),
          name: user ? (user.id_profile || {}).name || "" : "",
          email: user ? user.email || "" : "",
        };
      })()`),
      new Promise((resolve) => setTimeout(() => resolve({ reached: false }), 8_000)),
    ])) as SessionAnswer & { name?: string; email?: string };

    const verdict = sessionVerdict(raw);
    if (verdict !== "live") {
      logger.info("deepseek", "asked the service about the session", {
        verdict,
        status: raw?.status ?? null,
        reached: raw?.reached ?? false,
      });
    }
    return { verdict, name: raw?.name?.trim() || undefined, email: raw?.email?.trim() || undefined };
  } catch {
    return { verdict: "unknown" };
  }
}

/**
 * Does the profile hold a usable session?
 *
 * Opens the profile rather than trusting a file on disk: the token is in a
 * LevelDB that is locked while any browser has the profile open, and reading
 * it any other way is guesswork about a format nobody promised.
 */
export async function checkSignedIn(opts: OpenOptions & { tries?: number } = {}): Promise<SignedInCheck> {
  // Tried more than once because both ways of failing are transient. The
  // profile can still be held by a Chrome that has not finished exiting —
  // seconds, on a cold machine — and the token is written after the app
  // hydrates, so the first read of a good profile can come back empty.
  const tries = Math.max(1, opts.tries ?? 1);
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const page = await chatPage(opts);
      // The app writes its session after the first paint, so a check the
      // instant the document exists can read an empty store on a good profile.
      await page.waitForTimeout(2_500);
      const storage = await readStorage(page);
      const ok = isSignedIn(storage);
      if (ok) {
        // The token is there. Whether it still means anything is DeepSeek's
        // to say, and it will say so for the price of the request this line
        // was already making to fill in the account name.
        const asked = await askDeepSeek(page);
        if (asked.verdict === "dead") {
          logger.info("deepseek", "the token is in the profile and the service refuses it", {
            attempt,
          });
          // Same shape as an empty store, because it is the same answer to
          // the person: sign in. Retried like one too — a refusal seen once
          // on a page that was still settling should not end the matter.
          if (attempt === tries) return { signedIn: false };
          await page.waitForTimeout(2_000);
          continue;
        }
        logger.info("deepseek", "checked the session", {
          signedIn: true,
          attempt,
          confirmed: asked.verdict === "live",
        });
        return { signedIn: true, account: asked.name, email: asked.email };
      }
      // An empty store on the last attempt is the answer; before that it may
      // just be early, so give the page another moment and look again.
      if (attempt === tries) {
        logger.info("deepseek", "checked the session", { signedIn: false, attempt });
        return { signedIn: false };
      }
      lastError = undefined;
      await page.waitForTimeout(2_000);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn("deepseek", "could not check the session", { attempt, tries, error: lastError });
      // A failed launch leaves nothing to reuse; drop it so the next attempt
      // opens the profile again rather than reusing a dead context.
      await closeBrowser().catch(() => {});
      if (attempt < tries) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  // Every attempt threw: say so rather than reporting a session that was
  // never looked for.
  return { signedIn: false, error: lastError };
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
/**
 * How the end of an answer is recognised, and what it costs.
 *
 * There is no signal to subscribe to — no disabled composer, no labelled stop
 * control, nothing semantic that changes while DeepSeek writes — so the end
 * is "the text stopped growing". The only question is how finely to look.
 *
 * It used to look every 1.2 seconds and wait for three unchanged reads, which
 * put 3.6 seconds of dead time after every answer: a two-character reply took
 * 7.8 seconds, and the app felt slower than the same chat in a browser for a
 * reason that was entirely OnFlip's. Reading the page costs 1–8ms, measured
 * during a live generation, so looking often is free and the coarse interval
 * bought nothing.
 *
 * 350ms with six unchanged reads keeps a 2.1-second stillness window — still
 * long enough to ride out a pause mid-stream — while cutting about a second
 * and a half off every turn and tripling how often the answer updates on
 * screen as it arrives.
 */
const SETTLE_POLLS = 6;
const POLL_MS = 350;
/** How long the page may show nothing new before the send is called failed. */
const SILENCE_MS = 90_000;

/** How often to ask the page whether it has already said no. */
const SERVICE_CHECK_MS = 4_000;

/** The last assistant reply, and how many are mounted, in one read. */
async function readLast(page: Page): Promise<{ text: string; count: number }> {
  const nodes = (await page.evaluate(EXTRACT_REPLY_SCRIPT).catch(() => null)) as unknown;
  const count = await page.$$eval(ASSISTANT_SELECTOR, (els) => els.length).catch(() => 0);
  return { text: nodes ? toMarkdown(nodes as never) : "", count };
}

/**
 * Press DeepSeek's own stop button.
 *
 * While it writes, the send control becomes a stop control — same element,
 * `ds-button--primary`, with a rounded square where the arrow was. Clicking
 * it is what actually halts generation; abandoning the poll loop only stops
 * OnFlip watching, and leaves the page writing an answer nobody will read
 * into a thread the next turn will append to.
 *
 * Best-effort by design. If the button has gone the generation has already
 * finished, which is the outcome being asked for.
 */
async function stopGenerating(page: Page): Promise<void> {
  // Logged either way, because the two outcomes look identical from outside:
  // a turn that stopped, and a turn OnFlip stopped watching while the page
  // wrote on. This line is the difference, and a silent failure here is the
  // second one wearing the first one's clothes.
  try {
    // Playwright's own click, not a synthetic one dispatched from inside the
    // page. The first version called `.click()` on whatever sits under the
    // button's centre, which is the icon — an SVGElement, which has no
    // `click()` method. It threw on every stop, the throw was swallowed, and
    // the result was precisely the failure above: the turn ended in the app
    // while DeepSeek carried on writing. A real input event has no such gap,
    // and it lands on the icon or the button equally.
    await page.click(STOP_BUTTON, { timeout: 3_000 });
    logger.info("deepseek", "stop pressed", { clicked: true });
  } catch (e) {
    // Not necessarily a failure: the button is gone the moment the answer
    // finishes, which is the outcome being asked for.
    logger.info("deepseek", "stop not pressed", {
      why: e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : String(e).slice(0, 120),
    });
  }
}

export async function sendTurn(
  text: string,
  opts: OpenOptions & {
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Called with the answer so far, each time it grows.
     *
     * The reply is polled rather than streamed — DeepSeek's page gives no
     * event to subscribe to — but it is polled every 1.2 seconds anyway to
     * decide when the answer has settled, and handing that partial text back
     * costs nothing. Without it a turn shows "working" for a minute and then
     * the whole answer at once, which reads as a hang rather than as thinking.
     */
    onProgress?: (partial: string) => void;
  } = {}
): Promise<SendResult> {
  const started = Date.now();
  let page = await chatPage(opts);
  if (pendingNewChat) {
    pendingNewChat = false;
    await gotoChat(page);
    await page.waitForTimeout(2_000);
  }
  // Both signals, because neither is sufficient alone. The node count is not
  // monotonic — DeepSeek renders the transcript into a virtual list and
  // unmounts what scrolls out of view, measured at four visible nodes after
  // five turns — so waiting for it to grow hangs forever on a long
  // conversation. The last reply's text catches that; the count catches the
  // rarer case of a model repeating itself word for word.
  const before = await readLast(page);

  await attachPending(page);

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
  // The page not being ready is the failure one retry fixes, so say so in
  // the code rather than leaving it to be guessed from the sentence.
  if (accepted < 0) {
    throw new DeepSeekError("DeepSeek's composer was not on the page.", "composer-refused");
  }
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
  let lastChange = Date.now();
  // First look a few seconds in: the page needs a moment to render what
  // it is going to say, and a check at zero would read an empty shell.
  let lastServiceCheck = Date.now();
  while (Date.now() < deadline) {
    try {
      // Stop means stop. Without this the signal was accepted and ignored:
      // the UI showed the turn ended while the loop kept polling and the page
      // kept generating, so the next turn began behind an answer still being
      // written.
      if (opts.signal?.aborted) {
        await stopGenerating(page);
        throw new DeepSeekError("interrupted", "interrupted");
      }
      await page.waitForTimeout(POLL_MS);
      const now = await readLast(page);
      const fresh = now.count > before.count || now.text !== before.text;
      if (!fresh || !now.text) {
        // Before waiting the window out: is the page already saying why
        // nothing is coming? Checked on a slow timer rather than every
        // poll - reading the whole body three times a second to catch a
        // sentence that persists would cost more than it saves.
        if (!last && Date.now() - lastServiceCheck > SERVICE_CHECK_MS) {
          lastServiceCheck = Date.now();
          const said = await serviceMessage(page);
          if (said) {
            throw new DeepSeekError(
              `DeepSeek says: ${said.text}`,
              said.code
            );
          }
        }
        // Nothing has moved. A reply that has not started at all within the
        // silence window is a failure worth reporting, not something to sit
        // on until the ten-minute deadline while the UI says "working".
        if (Date.now() - lastChange > SILENCE_MS) {
          // Which of the two it is, not a sentence saying it might be
          // either. The session is right there in the page's own storage,
          // so there is nothing to guess about: a profile that is signed
          // out cannot be fixed by sending again, and one that is not is
          // the case that always could have been.
          const storage = await readStorage(page).catch(() => ({}));
          if (!isSignedIn(storage)) {
            throw new DeepSeekError(
              "The browser profile is signed out of DeepSeek, so the message went nowhere. Sign in from the account menu, then send again.",
              "signed-out"
            );
          }
          throw new DeepSeekError(
            `DeepSeek did not start answering within ${SILENCE_MS / 1_000}s. The session is still valid, so the send did not land.`,
            "send-not-landed"
          );
        }
        continue;
      }
      lastChange = Date.now();
      if (now.text === last) quiet++;
      else {
        quiet = 0;
        // Only on a change, so a settled answer is not re-emitted three times
        // while the loop confirms it has stopped growing.
        opts.onProgress?.(now.text);
      }
      last = now.text;
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
      const answering = page.url();
      await closeBrowser();
      page = await chatPage(opts);
      // The reply is in the conversation, not at the chat root a reopened
      // browser lands on.
      if (/\/chat\/s\//.test(answering)) {
        await page.goto(answering, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      }
      await page.waitForTimeout(4_000);
      quiet = 0;
    }
  }
  // Deliberately uncoded: the reply budget running out is classified by the
  // default, which is a retry. That is what both drivers have always done
  // with a budget timeout and it was not changed here - but it is a
  // DeepSeekError like the rest, so the rule that every failure from this
  // driver is one type holds, and giving it a code later is a one-line change.
  if (last === null) {
    throw new DeepSeekError("DeepSeek did not answer before the deadline.");
  }
  noteConversation(page.url());
  const ms = Date.now() - started;
  logger.info("deepseek", "turn answered", { chars: last.length, ms });
  return { reply: last, ms };
}

/**
 * The conversation the driver is in, if any.
 *
 * DeepSeek puts the id in the path once a chat has a first message; a fresh
 * one sits at the root. The transport reads this to know whether the thread
 * it has been appending to still exists — if it does not, the whole
 * transcript has to be replayed.
 */
let conversationId: string | null = null;

export function currentConversationId(): string | null {
  return conversationId;
}

function forgetConversation(): void {
  conversationId = null;
}

/**
 * The conversation, but only if the page is actually on it.
 *
 * The transport decides from this whether it may send just the new
 * messages. The id alone was not enough: it outlived the browser — Stop
 * closes it after five seconds, a crash reopens it — and the reopened page
 * sits at the chat root, so "continue" went out as the entire content of a
 * fresh chat with no system prompt and no history, and the model answered
 * like the plain web app from then on.
 */
export function confirmConversation(): string | null {
  if (!conversationId) return null;
  const page = context?.pages()[0];
  if (!page || !page.url().includes(conversationId)) {
    logger.info("deepseek", "the page is not on the conversation any more; replaying", {
      conversation: conversationId,
      url: page ? page.url() : null,
    });
    forgetConversation();
    return null;
  }
  return conversationId;
}

/** Abandon the current thread; the next send starts a new one. */
export function newChat(): void {
  conversationId = null;
  pendingNewChat = true;
}

let pendingNewChat = false;

/** Note the conversation from the page's URL, e.g. /a/chat/s/<id>. */
/** Exported for the tests of this bookkeeping; the driver calls it after every answer. */
export function noteConversation(url: string): void {
  const m = /\/a\/chat\/s\/([0-9a-f-]{8,})/i.exec(url) || /\/chat\/s\/([0-9a-f-]{8,})/i.exec(url);
  conversationId = m ? m[1] : conversationId;
}

/**
 * Are the two selectors this driver depends on still on the page?
 *
 * Small on purpose. ChatGPT's driver reads a dozen things from its DOM and
 * needs a census; this one needs a composer to type into and a node to read
 * the answer out of, and if either has moved, nothing else matters.
 */
/**
 * The handles OnFlip drives on DeepSeek's page, by name.
 *
 * A list rather than scattered queries, because the failure this exists to
 * catch is silent: the service redesigns its page, a click finds nothing,
 * and nothing happens. On 14 September 2026 DeepSeek unified Instant,
 * Expert and Vision; the radio group went with them, and OnFlip's picker
 * went on offering all three - each one doing nothing at all - because the
 * old check looked only for the composer.
 *
 * `expect` is the point. A control that should be there and is not is a
 * break. A control that was retired and comes back is also news, because
 * it means a choice exists again that OnFlip is no longer making.
 * `optional` is for the parts that only exist once a reply is on screen.
 */
const DEEPSEEK_CONTRACT: {
  id: string;
  what: string;
  selector: string;
  expect: "present" | "absent" | "optional";
}[] = [
  { id: "composer", what: "the message box", selector: "textarea", expect: "present" },
  {
    id: "sendControl",
    what: "the send and stop button",
    selector: ".ds-button--primary",
    expect: "present",
  },
  {
    id: "deepThink",
    what: "the DeepThink toggle, which carries the thinking setting",
    selector: ".ds-toggle-button[aria-pressed]",
    expect: "present",
  },
  {
    id: "fileInput",
    what: "the attachment input",
    selector: "input[type=file]",
    expect: "present",
  },
  {
    id: "modelChooser",
    what: "the Instant/Expert/Vision chooser, retired on 14 September 2026",
    selector: "[role=radio][data-model-type]",
    expect: "absent",
  },
  {
    id: "assistantReply",
    what: "where a reply is read from",
    selector: ".ds-markdown.ds-assistant-message-main-content",
    expect: "optional",
  },
  { id: "codeBlock", what: "a code block in a reply", selector: ".md-code-block", expect: "optional" },
];

/**
 * Hold DeepSeek's page against that contract and say what has moved.
 *
 * Read-only and safe to run at any time: it counts elements and touches
 * nothing. The detail is written for someone who will have to fix it, so
 * it names the control rather than the selector.
 */
export async function checkSelectors(): Promise<{
  ok: boolean;
  matches: Record<string, number>;
  detail: string;
}> {
  try {
    const page = await chatPage();
    // The composer mounts after the shell, so a census taken the instant
    // the document is ready reports a drift that is really a race.
    await page.waitForSelector("textarea", { timeout: 15_000, state: "attached" }).catch(() => null);
    // One census in one round trip, built from the contract so a selector
    // can never be checked here and used somewhere else.
    const script =
      "({" +
      DEEPSEEK_CONTRACT.map(
        (c) =>
          JSON.stringify(c.id) +
          ": document.querySelectorAll(" +
          JSON.stringify(c.selector) +
          ").length"
      ).join(",") +
      "})";
    const matches = (await page.evaluate(script)) as Record<string, number>;

    const broken: string[] = [];
    const returned: string[] = [];
    for (const c of DEEPSEEK_CONTRACT) {
      const n = matches[c.id] ?? 0;
      if (c.expect === "present" && n === 0) broken.push(c.what);
      if (c.expect === "absent" && n > 0) returned.push(c.what);
    }

    logger.info("deepseek", "checked the page against the contract", { matches, broken, returned });

    if (broken.length) {
      return {
        ok: false,
        matches,
        detail:
          "DeepSeek's page has changed: " +
          broken.join("; ") +
          " could not be found. Either the profile is signed out, or the page was redesigned and this part of OnFlip needs updating.",
      };
    }
    if (returned.length) {
      return {
        ok: false,
        matches,
        detail:
          "DeepSeek has brought something back: " +
          returned.join("; ") +
          " is on the page again, and OnFlip is no longer using it.",
      };
    }
    return {
      ok: true,
      matches,
      detail: "Everything OnFlip drives on DeepSeek's page is where it should be.",
    };
  } catch (e) {
    return {
      ok: false,
      matches: {},
      detail: `Could not reach DeepSeek: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * DeepSeek's reasoning switch.
 *
 * Not levels — one toggle beside the composer, labelled "Deep thinking" in
 * whatever language the account is set to. So OnFlip's four levels collapse
 * to two here, and `wantsDeepThink` decides which side of the line a level
 * falls on.
 *
 * Found by `aria-pressed` rather than by class. Everything else on that page
 * is hashed — `f79352dc`, `_6dbc175` — and will change on their next deploy,
 * but the toggle carries a real ARIA state, which is both how its current
 * position is read and the only durable handle on it. The label match is a
 * fallback across the languages the UI ships in, and the first toggle is the
 * last resort: DeepThink sits left of search.
 */
export function wantsDeepThink(level: string | undefined): boolean {
  return level === "low" || level === "medium" || level === "high";
}

const DEEP_THINK_LABELS = "deepthink|deep think|глубок|深度思考|chuqur";

export async function setDeepThink(on: boolean): Promise<boolean> {
  try {
    const page = await chatPage();
    // The composer's toggles render about two seconds after the document, so
    // a query the moment the page is ready finds nothing and every turn
    // silently runs at whatever effort was left over. Waited for rather than
    // slept past, so a fast machine is not punished and a slow one still works.
    await page
      .waitForSelector(".ds-toggle-button", { timeout: 15_000, state: "attached" })
      .catch(() => null);
    const script = (want: boolean) => `(() => {
      const labels = /${DEEP_THINK_LABELS}/i;
      const toggles = Array.from(document.querySelectorAll(".ds-toggle-button"));
      const el = toggles.find((t) => labels.test(t.textContent || "")) || toggles[0];
      if (!el) return { found: false, state: null };
      const state = el.getAttribute("aria-pressed") === "true";
      if (state !== ${want}) {
        const r = el.getBoundingClientRect();
        (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) || el).click();
      }
      return { found: true, state };
    })()`;
    const before = (await page.evaluate(script(on))) as { found: boolean; state: boolean | null };
    if (!before.found) {
      logger.warn("deepseek", "the deep-thinking toggle was not on the page");
      return false;
    }
    if (before.state === on) return true;
    // Confirm rather than assume: a click that did not land would otherwise
    // leave every turn running at the wrong effort, silently.
    await page.waitForTimeout(600);
    const after = (await page.evaluate(script(on))) as { state: boolean | null };
    const ok = after.state === on;
    logger.info("deepseek", "deep thinking", { wanted: on, applied: ok });
    return ok;
  } catch (e) {
    logger.warn("deepseek", "could not set deep thinking", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * The page's own mode names, for a chooser it no longer shows.
 *
 * DeepSeek unified the three modes on 14 September 2026 and the radio
 * group went with them. This is kept rather than deleted because the
 * cost of keeping it is a few lines and the cost of being wrong about
 * that is a silent no-op - which is exactly what this file has just
 * been fixed for. If a chooser comes back, it starts working again.
 */
export const DEEPSEEK_MODES = {
  "deepseek-chat": "default",
  "deepseek-instant": "default",
  "deepseek-expert": "expert",
  "deepseek-vision": "vision",
} as const;

export type DeepSeekModel = keyof typeof DEEPSEEK_MODES;

/** The page's mode for a model slug, defaulting to Instant. */
export function modeFor(slug: string | undefined): string {
  return DEEPSEEK_MODES[(slug ?? "") as DeepSeekModel] ?? "default";
}

/**
 * Choose a mode, when the page is still offering a choice.
 *
 * Answers false when the group is absent, which has two causes and used
 * to be read as only one. Mid-conversation the control is genuinely gone
 * and that is not a fault. But since 14 September 2026 it is gone on a
 * fresh chat too, because DeepSeek unified the modes — and reading that
 * as the harmless case is how a picker went on offering Instant, Expert
 * and Vision while every one of them did nothing.
 *
 * So absence is now said out loud once per attempt, at info because it
 * is the expected state today and not a failure, and the caller only
 * asks when there is more than one model to ask about.
 */
export async function setMode(mode: string): Promise<boolean> {
  try {
    const page = await chatPage();
    const script = (want: string) => `(() => {
      const radios = Array.from(document.querySelectorAll("[role=radio][data-model-type]"));
      if (!radios.length) return { present: false, current: null };
      const el = radios.find((r) => r.getAttribute("data-model-type") === ${JSON.stringify(want)});
      const current = (radios.find((r) => r.getAttribute("aria-checked") === "true") || {})
        .getAttribute ? radios.find((r) => r.getAttribute("aria-checked") === "true").getAttribute("data-model-type") : null;
      if (!el) return { present: true, current, missing: true };
      if (current !== ${JSON.stringify(want)}) {
        const b = el.getBoundingClientRect();
        (document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) || el).click();
      }
      return { present: true, current };
    })()`;
    const before = (await page.evaluate(script(mode))) as {
      present: boolean;
      current: string | null;
      missing?: boolean;
    };
    if (!before.present) {
      // The state since the modes were unified. Said at info rather than
      // warn because it is expected and not a failure - but said, because
      // the version of this that said nothing is what let a picker go on
      // offering three choices that did nothing.
      logger.info("deepseek", "no model chooser on the page", { wanted: mode });
      return false;
    }
    if (before.missing) {
      logger.warn("deepseek", "that mode is not offered on this account", { mode });
      return false;
    }
    if (before.current === mode) return true;
    await page.waitForTimeout(700);
    const after = (await page.evaluate(script(mode))) as { current: string | null };
    const ok = after.current === mode;
    logger.info("deepseek", "mode", { wanted: mode, applied: ok, was: before.current });
    return ok;
  } catch (e) {
    logger.warn("deepseek", "could not set the mode", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Files to attach to the next turn.
 *
 * DeepSeek does take attachments — a hidden multiple file input beside the
 * composer, accepting images among a long list of types — which an earlier
 * version of this provider did not know, and refused them instead. Reported
 * from the field in the worst possible case: Vision mode selected, a
 * screenshot attached, and the send going out with no image at all.
 *
 * Queued rather than sent immediately, because they belong to a turn: the
 * transport hands over text and files together, and a file left over from an
 * abandoned turn must not ride along with the next one.
 */
let pendingFiles: string[] = [];

export function queueAttachments(paths: string[]): void {
  pendingFiles = paths.filter((p) => p && fs.existsSync(p));
}

/** Put the queued files in the composer and wait for the page to take them. */
async function attachPending(page: Page): Promise<void> {
  const files = pendingFiles;
  pendingFiles = [];
  if (!files.length) return;

  const input = await page.waitForSelector("input[type=file]", { state: "attached", timeout: 15_000 }).catch(() => null);
  if (!input) {
    logger.warn("deepseek", "no file input on the page; the turn goes without its attachments", {
      files: files.length,
    });
    return;
  }
  // Wait for the page to show them. Sending before the upload finishes is how
  // a turn arrives describing an image that is not there — the failure this
  // whole path exists to avoid, and it is silent.
  //
  // Two signals, because an image and a document appear differently. An image
  // gets a thumbnail: a `blob:` <img> in the composer, up within about half a
  // second. Anything else gets a card with its name on it. The first version
  // of this check looked only for the name, which is the one thing an image
  // never shows — and OnFlip saves a pasted screenshot under a UUID — so it
  // waited its full minute on every send and then went out anyway.
  const names = files.map((f) => path.basename(f));
  const probe = `(() => {
    const imgs = Array.prototype.filter.call(
      document.querySelectorAll('img'),
      function (i) { return /^blob:|^data:/.test(i.src); }
    ).length;
    const text = document.body ? document.body.innerText : "";
    const named = ${JSON.stringify(names)}.filter(function (n) {
      return text.indexOf(n) !== -1;
    }).length;
    return { imgs: imgs, named: named };
  })()`;
  const look = () =>
    page.evaluate(probe).catch(() => ({ imgs: 0, named: 0 })) as Promise<{
      imgs: number;
      named: number;
    }>;

  const before = await look();
  await input.setInputFiles(files);

  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    await page.waitForTimeout(300);
    const now = await look();
    ok = now.imgs > before.imgs || now.named > before.named;
  }
  logger.info("deepseek", "attached files", { count: files.length, confirmed: ok });
  if (!ok) logger.warn("deepseek", "nothing appeared in the composer; sending anyway", { names });
  // A moment for the upload to finish behind the thumbnail.
  await page.waitForTimeout(800);
}
