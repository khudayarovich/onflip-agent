import * as fs from "node:fs";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import type { FailureCode } from "../../chatgpt/backoff";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { paceNewChat, paceSend } from "../../chatgpt/backoff";
import { EXTRACT_REPLY as EXTRACT_REPLY_SCRIPT, normalizeNodes, toMarkdown } from "./extract";
import {
  QWEN_CHAT_URL,
  QWEN_ORIGIN,
  TOKEN_KEY,
  ROLE_KEY,
  conversationIdFrom,
  isGuestChat,
  isSignInPage,
  isSignedIn,
  qwenProfileDir,
} from "./session";
import { mkdirPrivate } from "../../config";
import { releaseProfileLock } from "../profile-lock";

/**
 * The browser OnFlip drives Qwen with.
 *
 * The same arrangement as DeepSeek's, for the same reason: a persistent
 * context on a profile a real Chrome signed in to. The sign-in happens in an
 * ordinary browser with no automation attached, because Google refuses OAuth
 * from a browser it can tell is driven and no amount of fingerprint work
 * changes that.
 *
 * Qwen adds one thing neither of the others has. Alibaba's risk-control
 * stack is live on the page — `AWSC`, `baxia` and `aplus` all present and
 * initialised — which is real bot detection rather than analytics. Nothing
 * here tries to defeat it, and nothing should: a genuine Chrome profile that
 * a person signed into is what it is meant to see, and that is exactly what
 * this drives. What it does mean is that a refusal from Qwen may be that
 * system rather than the model, so the service-message rules below name the
 * challenge wording and classify it as something a person clears, never as
 * something to retry into.
 *
 * Two things are better here than on DeepSeek, and the driver leans on both.
 * The controls carry real `aria-label`s — "Send", "Stop", "Select Model",
 * "New Chat" — which survive a redesign in a way a hashed class name does
 * not. And there is an actual end-of-answer signal: while Qwen writes, Send
 * is replaced by Stop. DeepSeek has nothing of the kind, which is why its
 * driver has to watch text stop growing and pay a stillness window for the
 * privilege.
 */

/**
 * A Qwen failure that knows what it is.
 *
 * The same lesson `DeepSeekError` carries, adopted here from the start
 * rather than after four silent failures: the classifier reads a code when
 * there is one and parses English prose when there is not, and a sentence
 * written for a person should not be parsed by a machine.
 */
class QwenError extends Error {
  constructor(
    message: string,
    readonly code?: FailureCode
  ) {
    super(message);
    this.name = "QwenError";
  }
}

/**
 * Did this navigation failure actually stop us getting there?
 *
 * `net::ERR_ABORTED` and "interrupted by another navigation" are the same
 * event described two ways: something else navigated while this request was
 * in flight. On a single-page app that something else is usually the app's
 * own router, which means the page very often arrives — at the address it
 * chose rather than the one that was asked for, and with the request that
 * asked reported as failed.
 *
 * Reported from a real machine, in the log of a turn that then failed: the
 * recovery navigated to the chat root, Chromium answered ERR_ABORTED, and
 * the error travelled up as though the browser had gone nowhere. The
 * recovery is fired within half a second of a send, which is exactly when
 * Qwen's own router is moving the page to the new conversation, so this is
 * not a rare collision — it is the normal case for the one navigation that
 * matters most.
 *
 * So the address is consulted before the failure is believed. The rule
 * everywhere else in this file, applied to navigation as well: what the page
 * is actually showing outranks what a call reported about it.
 */
export function isNavigationRace(message: string): boolean {
  return /interrupted by another navigation|ERR_ABORTED/i.test(message);
}

async function gotoChat(page: Page): Promise<void> {
  try {
    await page.goto(QWEN_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!isNavigationRace(message)) throw e;

    // Give the navigation that won the race a moment to settle, then look.
    await page.waitForTimeout(1_200).catch(() => {});
    if (isUsableChatUrl(page.url())) {
      logger.info("qwen", "the navigation reported a race and arrived anyway", {
        url: page.url(),
        reported: message.split("\n")[0].slice(0, 120),
      });
      return;
    }

    // It did not arrive, or it arrived somewhere this driver has to leave.
    // One more attempt, now that whatever was navigating has finished.
    try {
      await page.goto(QWEN_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (again) {
      const second = again instanceof Error ? again.message : String(again);
      if (isNavigationRace(second)) {
        await page.waitForTimeout(1_200).catch(() => {});
        if (isUsableChatUrl(page.url())) return;
      }
      throw new QwenError(
        `Loading the Qwen chat was interrupted by another navigation. Retrying. (${second})`,
        "send-not-landed"
      );
    }
  }
}

/** Where an assistant reply lives. */
const ASSISTANT_SELECTOR = ".qwen-chat-message-assistant";
/** The composer, which carries a real class rather than a hashed one. */
const COMPOSER = "textarea.message-input-textarea";
/** Send. Present but `.disabled` until the composer has something in it. */
const SEND_BUTTON = "button.send-button";
/** A message of ours on the page, which is how a send is confirmed. */
const USER_MESSAGE = ".qwen-chat-message-user";
/**
 * Shown in Send's place while an answer is being written.
 *
 * A list rather than the single `button[aria-label="Stop"]` it used to be —
 * as hardening, and the investigation behind it is worth recording because
 * it did not end where it looked like it would.
 *
 * Qwen's page is `lang="ru-RU"` on the profile this drives, and most of its
 * labels are Russian: "Новый чат", "Прокрутить вниз", "Выбрать режим". An
 * English-only selector against that looked like the answer to years of
 * "works sometimes, freezes sometimes".
 *
 * It is not, and the component settles it. Qwen renders the control as:
 *
 *   className: "stop-button " + (disabled ? "disabled" : ""),
 *   "aria-label": t("Stop")
 *
 * The label does go through the translator — so it is locale-dependent in
 * principle — but the Russian bundle has no "Stop" key, and i18next falls
 * back to the key itself. It renders "Stop" in Russian, the old selector
 * matched, and the freeze had another cause.
 *
 * The class is the better signal regardless: it is not translated, it cannot
 * fall back to anything, and the control is only in the tree while an answer
 * is being written. So the class leads, and the labels are the fallback for
 * the day Qwen adds that key.
 *
 * The list stays anyway. It costs one CSS selector, it covers the day Qwen
 * translates that label or renames the class, and a driver that can lose
 * sight of the page's own progress indicator has no way to tell a model
 * thinking from a message that never arrived. What it must not do is claim
 * to have fixed something it did not.
 */
const STOP_BUTTON = [
  // A class is never translated, so it leads.
  "button.stop-button",
  'button[aria-label="Stop"]',
  // Prefix matches, so "Стоп генерации" is caught by "Стоп".
  'button[aria-label^="Стоп"]',
  'button[aria-label^="Остановить"]',
  'button[aria-label^="停止"]',
  'button[aria-label^="Detener"]',
  'button[aria-label^="Arrêter"]',
  'button[aria-label^="Stopp"]',
  'button[aria-label^="Toʻxtatish"]',
].join(", ");
/**
 * Ask Qwen whether this profile's token is still a session.
 *
 * `/api/v1/auths/` is Qwen's own answer, and it is not ambiguous. With the
 * dead token from the real profile it returns 401 and says so in words:
 * "Your session has expired, or the token is no longer valid. Please sign in
 * again to proceed." With a live one it returns the account.
 *
 * This replaces reading the page's Log in button, which was the 0.10.33 fix
 * and was wrong in the worst available direction. The header renders its
 * signed-out state *before* the app has heard back from this very endpoint —
 * measured on a real load: the button became visible at 1815ms and the 401
 * arrived at 2561ms, three quarters of a second later. So a genuinely
 * signed-in profile shows Log in for about a second on every load, and a
 * check that looked during that second told somebody who had just signed in
 * that they were signed out. Signing in again did not help, because the next
 * check raced the same way. That is the sign-in loop, and it was introduced
 * by the release that was meant to end it.
 *
 * A request has no such race: it answers about the session rather than about
 * what has painted so far.
 */
const SESSION_PROBE_SCRIPT = `(async () => {
  const token = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) || "";
  if (!token) return { status: 0, reached: true };
  try {
    const res = await fetch("/api/v1/auths/", {
      credentials: "include",
      headers: { authorization: "Bearer " + token },
    });
    return { status: res.status, reached: true };
  } catch (e) {
    return { status: 0, reached: false };
  }
})()`;

/**
 * Qwen talking, rather than the model answering.
 *
 * The login wall is the one that matters and the one a guest meets first: a
 * "Welcome to Qwen" modal appears over the chat, the send goes nowhere, and
 * the URL does not change — so without this the turn would wait out the full
 * silence window and then report a send that did not land. It landed. There
 * is simply nobody signed in to answer it.
 */
const SERVICE_MESSAGES: { pattern: RegExp; code: FailureCode }[] = [
  {
    // Russian taken from Qwen's own translation bundle rather than
    // translated here: "Welcome to Qwen" is "Добро пожаловать в Qwen" and
    // "Log in" is "Войти". The page ships in seventeen languages, so an
    // English-and-Chinese pattern was missing fifteen of them - and this
    // one decides whether somebody is told to sign in or left waiting out
    // the silence window.
    pattern: /welcome to qwen|log in to unlock|登录后即可|请先登录|добро пожаловать в qwen|войдите/i,
    code: "signed-out",
  },
  // Alibaba's risk control, or an ordinary challenge page. A person clears
  // these; sending again makes it worse.
  {
    pattern: /verify you are human|checking your browser|just a moment|滑动验证|安全验证|проверка браузера|подтвердите, что вы человек|минуточку/i,
    code: "refused",
  },
  {
    pattern: /rate limit|too many requests|请求过于频繁|访问频繁|слишком много запросов|превышен лимит/i,
    code: "throttled",
  },
  {
    pattern: /server (is )?busy|系统繁忙|服务器繁忙|服务异常|сервер занят|сервер перегружен/i,
    code: "service-error",
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
  const body = (await withTimeout(
    page.evaluate('(document.body && document.body.innerText) || ""'),
    "reading the page"
  ).catch(() => "")) as string;
  return matchServiceMessage(body);
}

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
  const dir = qwenProfileDir();
  mkdirPrivate(dir);
  // Chromium allows one process per profile directory and refuses the
  // second outright. On a Mac the sign-in browser is still alive after
  // its window closes, so without this the read that follows a sign-in
  // fails with "Failed to create a ProcessSingleton" - reported as "could
  // not check the session" to somebody who had just signed in.
  await releaseProfileLock(dir, (message, data) => logger.info("qwen", message, data));
  logger.info("qwen", "opening the browser", { profile: dir, headed: Boolean(opts.headed) });
  context = await chromium.launchPersistentContext(dir, {
    executablePath: executable(),
    headless: !opts.headed,
    viewport: null,
    args: ["--no-first-run", "--no-default-browser-check"],
    // Shorter than the 90-second default for the reason DeepSeek's driver
    // documents: the first launch on a profile a real Chrome has just
    // created loses its pipe when Chrome relaunches itself, and the caller
    // retries. Two attempts at the default spend three minutes first.
    timeout: 30_000,
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

/**
 * How long any single question to the page may take before it is a failure.
 *
 * `page.evaluate` has no timeout of its own and never will — Playwright's
 * default timeout covers clicks and waits, not script evaluation — so an
 * evaluate against a renderer that is busy, wedged or gone waits for as long
 * as the process lives. `$$eval` is the same thing wearing a helper's name,
 * and a `.catch()` on either is no protection at all: it handles a call that
 * rejects, not one that never comes back.
 *
 * Several sit in the path of every turn, and two of those are inside the
 * poll loop - counting the replies and reading the progress indicator. A
 * wedged renderer there stops the loop running at all, and the turn deadline
 * is only tested at the top of it, so the turn waits for ever with no
 * failure and nothing in the log after the last heartbeat. Every one of them
 * goes through this.
 *
 * That is what a turn stuck on "sending" with nothing in the log looks like
 * from outside, and it was reported exactly that way. Twenty seconds is far
 * beyond anything these take when the page is healthy — the reply read is
 * single-digit milliseconds — so crossing it means something is wrong rather
 * than slow, and a failure that says so can be retried. Silence cannot.
 */
const PAGE_CALL_MS = 20_000;

function withTimeout<T>(work: Promise<T>, what: string, ms = PAGE_CALL_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new QwenError(
              `Qwen's page stopped answering while ${what} (${Math.round(ms / 1000)}s).`,
              "send-not-landed"
            )
          ),
        ms
      );
    }),
  ]);
}

/** The page to work in, on Qwen, created if the context has none. */
/**
 * Is this address one a turn can be sent from, and a session read from, as
 * it stands?
 *
 * The rule used to be "anywhere under chat.qwen.ai", and that made the two
 * addresses OnFlip must escape into fixed points it could never leave:
 * `/c/guest` and `/auth` both start with the chat URL, so the page was
 * judged to be already where it belonged and no navigation happened.
 *
 * What that cost is in this machine's own log. A turn landed in a guest
 * conversation; the next turn opened "the page", got the same guest page
 * back, and sent into it again — and so did the one after that. Sending
 * from a guest conversation is never answered, so each turn spent its one
 * recovery climbing out of a hole the previous turn left it in, and a turn
 * whose re-send landed there too ended on "the session has expired — sign
 * in again". The session had not expired. The token was valid for another
 * 716 hours; the page was simply stuck.
 *
 * `checkSignedIn` reads the same page, so the banner said signed out for
 * the same reason, and its retries re-read the same stuck page three times
 * before agreeing with themselves.
 *
 * A real conversation — `/c/<uuid>` — is usable and must be left alone, or
 * every turn would start a new chat.
 */
export function isUsableChatUrl(url: string): boolean {
  if (!url || !url.startsWith(QWEN_CHAT_URL)) return false;
  // Qwen's own answer to "your session is not in effect", and the address
  // it redirects a guest conversation to once a session does exist.
  if (isGuestChat(url) || isSignInPage(url)) return false;
  return true;
}

export async function chatPage(opts: OpenOptions = {}): Promise<Page> {
  const ctx = await openBrowser(opts);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!isUsableChatUrl(page.url())) {
    await gotoChat(page);
  }
  return page;
}

/** Read the session out of a page's localStorage. */
export async function readStorage(page: Page): Promise<Record<string, string | null>> {
  return withTimeout(
    page.evaluate(
    ([tokenKey, roleKey]) => ({
      [tokenKey]: localStorage.getItem(tokenKey),
      [roleKey]: localStorage.getItem(roleKey),
    }),
      [TOKEN_KEY, ROLE_KEY]
    ),
    "reading the session"
  );
}

/**
 * What the profile's own storage says, including "it would not say".
 *
 * Three answers, not two, and the third is the point. A read can fail for
 * reasons that have nothing to do with a session — a page mid-navigation, a
 * renderer that is busy, an evaluate that timed out on a slow machine — and
 * treating that as "signed out" tells someone to go and fix something that
 * was never broken. This driver already says elsewhere that "not signed in"
 * and "could not look" are different answers; this is the type that makes it
 * impossible to forget.
 */
export type SessionState = "present" | "absent" | "unreadable";

/** What the service said about the token: accepted, refused, or no answer. */
export type SessionVerdict = "live" | "dead" | "unknown";

/**
 * What to do about a sign-in prompt on the page, given what the profile says.
 *
 * Pure, and exported, because this is the rule that was wrong: the old code
 * read the prompt and went straight to "signed out", never asking the token.
 * A rule worth getting wrong once is worth being able to hold against every
 * combination without a browser.
 *
 * - `absent`      — nothing in storage. Genuinely signed out; say so.
 * - `present`     — a session and a prompt disagree. Reload once; if the
 *                   prompt survives that, the token is most likely expired,
 *                   which has the same shape as a fresh one and so passes
 *                   `isSignedIn`.
 * - `unreadable`  — no verdict. Keep waiting; the silence window ends a turn
 *                   that nothing answers, and it says something true.
 */
export function verdictForPrompt(
  session: SessionState,
  alreadyReloaded: boolean
): "signed-out" | "reload" | "expired" | "wait" {
  if (session === "absent") return "signed-out";
  if (session === "unreadable") return "wait";
  return alreadyReloaded ? "expired" : "reload";
}

/**
 * The same judgement, from the two facts it actually rests on.
 *
 * Pure and exported because the bug it fixes is invisible from the outside
 * and cost a user a week of being told to sign in to an account they were
 * signed in to.
 *
 * `localStorage` belongs to an origin, not to a browser. A page sitting on
 * `about:blank`, on an error page, or part-way through a navigation has its
 * own empty storage, and `getItem` there answers `null` without throwing —
 * so a perfectly good session read as "no session at all", and the driver
 * reported the profile signed out. It was not. The page simply was not on
 * Qwen at that instant, which on a slower machine is a wider window, and is
 * why retrying "just worked": the next attempt found the page loaded.
 *
 * So the address is checked before the answer is believed. Off-origin is
 * "unreadable" — no verdict — and never "absent".
 */
export function sessionStateFrom(
  url: string,
  storage: Record<string, string | null | undefined> | null,
  session?: SessionVerdict
): SessionState {
  if (!url || !url.startsWith(QWEN_ORIGIN)) return "unreadable";
  // A guest conversation is Qwen saying the session is not in effect, and
  // it outranks anything in storage: the token sitting there is stale, and
  // believing it is how the app reported itself connected while every turn
  // went to a page that could not answer.
  if (isGuestChat(url)) return "absent";
  // The service's verdict outranks the token, because the token cannot be
  // checked offline: Qwen leaves a well-formed, unexpired one behind after
  // it stops honouring it, and that is the case this driver kept reading as
  // a live session.
  //
  // `unknown` is not a verdict and falls through to the token - the answer
  // this function gave before the service was ever asked. Nobody having
  // found out must never cost somebody a sign-in.
  if (session === "dead") return "absent";
  if (session === "live") return "present";
  if (!storage) return "unreadable";
  return isSignedIn(storage) ? "present" : "absent";
}

/** What came back from asking Qwen, as facts rather than a conclusion. */
export interface SessionAnswer {
  /** HTTP status, or 0 when there was no token to ask with or nobody answered. */
  status?: number;
  /** Did the request complete at all? False for offline, DNS, a timeout. */
  reached?: boolean;
}

/**
 * The rule, kept out of the page so it can be held against every answer.
 *
 * The same shape DeepSeek's uses, and for the same reason. Only the service
 * refusing the credential means signed out. An outage, a timeout, a shape
 * that changed are this code failing to find out, and `unknown` says so —
 * which falls back to the token, the behaviour before any of this. Being
 * wrong that way costs a request; being wrong the other way costs somebody a
 * sign-in that will not help, which is the fault this is fixing.
 */
export function qwenSessionVerdict(answer: SessionAnswer | null | undefined): SessionVerdict {
  if (!answer || answer.reached !== true) return "unknown";
  const status = answer.status ?? 0;
  // Reached the point of asking with nothing to ask with: an empty store by
  // another name, which this driver already calls signed out.
  if (status === 0) return "dead";
  if (status === 401 || status === 403) return "dead";
  if (status < 200 || status >= 300) return "unknown";
  return "live";
}

/**
 * Ask the service, and say which of the three answers came back.
 *
 * Any failure to ask is `unknown`. A driver that reports somebody signed out
 * because an evaluate timed out is the fault this file has spent six
 * releases correcting, in one direction or the other.
 */
async function askQwen(page: Page): Promise<SessionVerdict> {
  try {
    const raw = (await withTimeout(
      page.evaluate<SessionAnswer>(SESSION_PROBE_SCRIPT),
      "asking Qwen about the session"
    )) as SessionAnswer;
    const verdict = qwenSessionVerdict(raw);
    if (verdict !== "live") {
      logger.info("qwen", "asked the service about the session", {
        verdict,
        status: raw?.status ?? null,
        reached: raw?.reached ?? false,
      });
    }
    return verdict;
  } catch {
    return "unknown";
  }
}

async function sessionState(page: Page): Promise<SessionState> {
  let url = "";
  try {
    url = page.url();
    const storage = await readStorage(page);
    return sessionStateFrom(url, storage, await askQwen(page));
  } catch {
    return "unreadable";
  }
}

export interface SignedInCheck {
  signedIn: boolean;
  /** A name a person recognises, when the page shows one. Never a raw id. */
  account?: string;
  email?: string;
  /**
   * Why the profile could not be read, when that is what happened.
   *
   * "Not signed in" and "could not look" are different answers and the
   * difference is worth keeping: one is fixed by signing in and the other
   * is not.
   */
  error?: string;
}

/**
 * Whatever name the page is willing to show for the account.
 *
 * Qwen keeps no profile object in localStorage — only the token and a
 * `userRole` of "user" — so unlike DeepSeek there is nothing to read out of
 * storage, and this asks the page instead. Returning nothing is an ordinary
 * outcome, not a failure: the account bar falls back to "Qwen account",
 * which is better than a raw id where a person's name goes.
 */
async function readProfile(page: Page): Promise<{ name?: string; email?: string }> {
  const found = (await withTimeout(
    page.evaluate(
      `(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          const t = el && (el.getAttribute("title") || el.innerText || "");
          return t ? t.trim().split("\\n")[0].slice(0, 80) : "";
        };
        const email = (document.body.innerText.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/) || [""])[0];
        return {
          name: pick('[class*="user-name"]') || pick('[class*="account-name"]'),
          email,
        };
      })()`
    ),
    "reading the account"
  ).catch(() => null)) as { name?: string; email?: string } | null;
  const out: { name?: string; email?: string } = {};
  if (found?.name) out.name = found.name;
  if (found?.email) out.email = found.email;
  return out;
}

export async function checkSignedIn(
  opts: OpenOptions & { tries?: number } = {}
): Promise<SignedInCheck> {
  const tries = Math.max(1, opts.tries ?? 1);
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const page = await chatPage(opts);
      // The token is written as the app boots, so a page asked the instant
      // it loads can answer "no" about a profile that is perfectly signed
      // in. A short settle costs a second and removes a false negative that
      // sends people back through a sign-in they did not need.
      await page.waitForTimeout(1_200);
      // Through the same rule the turn uses, for the same reason: a page
      // that is not on Qwen's origin has empty storage of its own, and
      // reading that as "no session" is what put a signed-out banner over a
      // signed-in account.
      const state = sessionStateFrom(
        page.url(),
        await readStorage(page),
        // Asked of the service, not of the token and not of the header:
        // this is the check that draws the Sign in button, and the header
        // races the very request that decides what it should say.
        await askQwen(page)
      );
      if (state === "present") {
        const profile = await readProfile(page);
        return { signedIn: true, ...profile };
      }
      if (attempt < tries) {
        await page.waitForTimeout(1_500);
        continue;
      }
      // Out of attempts. "Absent" is a real answer and "unreadable" is not,
      // and the caller shows a different sentence for each — one sends the
      // user to the sign-in button, the other does not.
      return state === "absent"
        ? { signedIn: false }
        : { signedIn: false, error: `the page was not on ${QWEN_ORIGIN} (${page.url()})` };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return { signedIn: false, error: lastError };
}

export interface SendResult {
  reply: string;
  /** How long the answer took to settle, for the log. */
  ms: number;
}

/**
 * How the end of an answer is recognised.
 *
 * Qwen gives a real signal, which DeepSeek does not: while it writes, the
 * Send button is replaced by one labelled Stop. So the end is "Stop is gone"
 * rather than "the text stopped growing", and the settle window exists only
 * to cover the gap between the button going and the last frame of text
 * landing — two polls, not the six a text-only heuristic needs.
 *
 * Polling at 350ms because reading the page costs single-digit milliseconds
 * and a fine interval is what makes the answer appear as it is written
 * rather than all at once at the end.
 */
const SETTLE_POLLS = 2;
const POLL_MS = 350;
/** How long the page may show nothing new before the send is called failed. */
const SILENCE_MS = 90_000;

/**
 * The same window, for a page whose "working" signal cannot be seen.
 *
 * The ninety seconds above is only defensible because the page is expected
 * to say when it is working: a model thinking before it writes shows the
 * Stop control, which holds the clock open. Where that control cannot be
 * found — a locale whose label this driver does not know, a build that
 * renamed the class — thinking and silence look identical, and ninety
 * seconds then kills answers that were on their way.
 *
 * Not a hypothetical worth dismissing either: the selector was English-only
 * for this driver's whole history against a page that renders in Russian.
 * That turned out not to be the fault — Qwen leaves that particular label
 * untranslated — but it was one selector away from being true, and nothing
 * in the driver would have reported it.
 *
 * Longer, and only used when the signal has never once been seen. The send
 * itself is not in doubt — `submit` verifies the message reached the page
 * before the wait begins — so what is being waited on is the answer, and the
 * turn deadline still bounds it.
 */
const SILENCE_BLIND_MS = 4 * 60_000;

/**
 * Has this process ever seen Qwen's Stop control?
 *
 * Module-level rather than per turn: one sighting anywhere proves the
 * selector works against this page, and a turn where the model thinks for
 * two minutes would otherwise conclude the opposite about itself.
 */
let stopSignalSeen = false;

/** How long silence may last before it means something, given what we can see. */
export function silenceWindowMs(
  signalSeen: boolean,
  quiet: number = SILENCE_MS,
  blind: number = SILENCE_BLIND_MS
): number {
  return signalSeen ? quiet : blind;
}

/**
 * How long Qwen may claim to be working without producing a character.
 *
 * "Generating" here means one thing: the Stop control is on the page. That
 * is a good signal for a model thinking before it writes, and it is also a
 * piece of UI that can be left behind — an answer interrupted mid-stream,
 * a socket dropped, a render that never cleaned up. When it is stale it is
 * indistinguishable from a model deep in thought, and it says so forever.
 *
 * That mattered because "generating" reset the silence clock on every poll.
 * A stuck Stop button therefore made the silence window unreachable, and
 * the turn ran to the full reply timeout — ten minutes of a UI saying
 * "thinking" with nothing behind it. Reported after a sub-agent was
 * interrupted: every turn afterwards froze the same way, because each one
 * started on a page still showing the last answer's Stop control.
 *
 * So thinking is allowed, and bounded. Past this, with not one character
 * written, the claim stops holding the clock open and the silence window
 * is allowed to do its job.
 */
const THINKING_MS = 150_000;

/**
 * Should a page claiming to work be believed enough to keep waiting?
 *
 * Pure, because the alternative is discovering the answer in ten-minute
 * increments. `since` is when this stretch of claimed work began, and text
 * arriving at any point makes the question moot — the answer is happening.
 */
export function thinkingStillCredible(
  generating: boolean,
  wroteAnything: boolean,
  sinceMs: number,
  limitMs: number = THINKING_MS
): boolean {
  if (!generating) return false;
  if (wroteAnything) return true;
  return sinceMs < limitMs;
}
/** How often to ask the page whether it has already said no. */
const SERVICE_CHECK_MS = 4_000;

/**
 * How long a finished-looking answer waits on a Stop control that will not go.
 *
 * Only reached when the page contradicts itself: the text has stopped moving
 * but Stop is still on screen. Sixty seconds because the innocent version of
 * that — a model pausing mid-answer to think — is common and a shorter
 * window would cut real answers in half.
 */
const STUCK_STOP_MS = 60_000;

/** The last assistant reply, whether one is being written, and how many exist. */
async function readLast(page: Page): Promise<{ text: string; count: number; generating: boolean }> {
  const nodes = (await withTimeout(page.evaluate(EXTRACT_REPLY_SCRIPT), "reading the reply").catch(
    () => null
  )) as unknown;
  // Every question to the page is bounded, including these two.
  //
  // `.catch()` handles a call that *rejects*; it does nothing about one that
  // never comes back, and `$$eval` runs script in the page exactly as
  // `evaluate` does — with no timeout of its own, for the reason set out
  // above. These two sit in the poll loop, so one wedged renderer stops the
  // loop running at all, and the turn deadline is only checked at the top of
  // it: the turn then waits for ever, with no failure and nothing in the log
  // after the last heartbeat.
  const count = (await withTimeout(
    page.$$eval(ASSISTANT_SELECTOR, (els) => els.length),
    "counting the replies"
  ).catch(() => 0)) as number;
  const generating = (await withTimeout(
    page.$$eval(STOP_BUTTON, (els) => els.length > 0),
    "reading the progress indicator"
  ).catch(() => false)) as boolean;
  // The page hands back Monaco's lines as it found them; the rules that turn
  // those into text — order, indentation, trailing blanks — live in
  // `normalizeNodes`, where they are tested.
  return { text: nodes ? toMarkdown(normalizeNodes(nodes as never)) : "", count, generating };
}

/**
 * Press Qwen's own stop button.
 *
 * Abandoning the poll loop only stops OnFlip watching; it leaves the page
 * writing an answer nobody will read into a thread the next turn appends to.
 * Playwright's own click rather than a synthetic one, because the centre of
 * the button is its icon and an SVG element has no `click()` method — the
 * mistake DeepSeek's driver made and logged.
 */
/**
 * Stop the answer, and check that it stopped.
 *
 * Try, then CHECK, then escalate — the rule `submit` already follows, for
 * the same reason. Qwen marks controls disabled with a CSS class rather than
 * the attribute, so Playwright's actionability check reads them as clickable
 * and the click lands on nothing. This used to click once and take the click
 * not throwing as success.
 *
 * What that cost: an interrupted turn left the page still generating, every
 * turn after it began behind a live answer, saw a Stop control that was
 * never going away, and waited out the full reply timeout. Reported as a
 * session that froze after a sub-agent was stopped and would not continue
 * however many times it was asked.
 *
 * Returns whether the page is actually quiet, so the caller can decide what
 * a refusal is worth — here, a reload, which always works.
 */
async function stopGenerating(page: Page): Promise<boolean> {
  for (const attempt of [1, 2]) {
    await pressStop(page, attempt);
    await page.waitForTimeout(700);
    if (!(await isGenerating(page))) {
      logger.info("qwen", "the page is quiet", { attempt });
      return true;
    }
  }
  logger.warn("qwen", "the page is still generating after being asked to stop");
  return false;
}

/** Is Qwen's own Stop control on the page? */
async function isGenerating(page: Page): Promise<boolean> {
  try {
    return (await withTimeout(
      page.evaluate(`Boolean(document.querySelector(${JSON.stringify(STOP_BUTTON)}))`),
      "reading the stop control"
    )) as boolean;
  } catch {
    // Could not look. Saying "yes" would block a turn on a guess.
    return false;
  }
}

/**
 * Make sure a new turn does not begin behind the last one's answer.
 *
 * The page is shared between turns, and between a parent and its sub-agents,
 * so an answer that was interrupted — or one whose Stop control was simply
 * left on screen — is still there when the next message is sent. The wait
 * loop then reads that stale control as "working" and waits on an answer
 * that finished, or never was.
 *
 * Asked before every send, and cheap when the page is already quiet, which
 * is the ordinary case.
 */
async function settlePage(page: Page): Promise<void> {
  if (!(await isGenerating(page))) return;
  logger.warn("qwen", "the page was still generating when a turn began; settling it");
  if (await stopGenerating(page)) return;
  // It would not stop. A reload always does, and losing a half-written
  // answer nobody is waiting for costs nothing.
  await gotoChat(page);
  await page
    .waitForSelector(COMPOSER, { timeout: 20_000 })
    .catch(() => logger.warn("qwen", "the composer did not come back after settling the page"));
}

async function pressStop(page: Page, attempt: number): Promise<void> {
  try {
    await page.click(STOP_BUTTON, { timeout: 3_000 });
    logger.info("qwen", "stop pressed", { clicked: true, attempt });
  } catch (e) {
    // Not necessarily a failure: the button is gone the moment the answer
    // finishes, which is the outcome being asked for.
    logger.info("qwen", "stop not pressed", {
      attempt,
      why: e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : String(e).slice(0, 120),
    });
  }
}

export async function sendTurn(
  text: string,
  opts: OpenOptions & {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Called with the answer so far, each time it grows. */
    onProgress?: (partial: string) => void;
  } = {}
): Promise<SendResult> {
  const started = Date.now();
  // Bracketing the setup, because a turn that hangs before the first poll
  // used to leave nothing at all in the log between the user's message and
  // silence - which is what made a stuck send impossible to place.
  // A floor between messages, the same one ChatGPT's transport has kept
  // since an account was told it was sending too quickly. A tool loop can
  // finish in milliseconds and come straight back; a person cannot, and
  // Alibaba's risk control is watching this page for exactly that.
  //
  // Added after a session died mid-task: three turns answered, then two
  // that never started, then a sign-in prompt over a token still in place.
  // That is the shape of a service ending a session under load, not of a
  // driver breaking, and pacing is the part of it OnFlip controls.
  await paceSend(opts.signal);
  logger.info("qwen", "turn: opening the page", { chars: text.length });
  let page = await chatPage(opts);
  if (pendingNewChat) {
    pendingNewChat = false;
    // Opening a conversation is the expensive request as far as an abuse
    // control is concerned, and the agent opens them far more eagerly than
    // a person does - a compaction, a sub-agent, a recovery each start one.
    await paceNewChat(opts.signal);
    await gotoChat(page);
    // Wait for the page rather than for a number.
    //
    // A fixed two seconds is a guess that is generous on one machine and
    // short on another, and the cost of it being short is the failure this
    // driver has been chasing: a send that arrives before Qwen has applied
    // the session to a freshly loaded page is treated as a guest send, and a
    // guest send is never answered. The composer appearing is the page
    // saying it is ready to take one.
    await page
      .waitForSelector(COMPOSER, { timeout: 20_000 })
      .catch(() => logger.warn("qwen", "the composer did not appear on the new chat"));
    await page.waitForTimeout(1_500);
  }
  // Never begin behind the previous answer. The page is shared between
  // turns and with any sub-agent, so a Stop control left behind by an
  // interrupted one would be read as this turn working.
  await settlePage(page);
  const before = await readLast(page);

  /**
   * Put the turn in the composer and press send.
   *
   * A function rather than a straight line because it can be needed twice:
   * a sign-in prompt over a live session is recovered by reloading, and a
   * reload empties the composer. Without this the recovery left the loop
   * waiting for a reply to a message that had never been sent.
   */
  const submit = async (): Promise<void> => {
    await page.click(COMPOSER).catch(() => {
      /* focus is a nicety; the fill below is what matters */
    });
    // A string rather than a callback: this package is built without the DOM
    // library, so nothing here may name `document`. React owns the textarea's
    // value, so the native setter is what gets past its wrapper — typing into
    // `el.value` directly leaves React's state holding the old string and the
    // Send button disabled.
    const fill = `(() => {
      const el = document.querySelector(${JSON.stringify(COMPOSER)});
      if (!el) return -1;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value.length;
    })()`;
    const accepted = (await withTimeout(page.evaluate(fill), "filling the composer")) as number;
    if (accepted < 0) {
      throw new QwenError("Qwen's composer was not on the page.", "composer-refused");
    }
    if (accepted < text.length) {
      logger.warn("qwen", "the composer truncated the turn", { sent: text.length, accepted });
    }
    await page.waitForTimeout(300);

    // Try, then CHECK, then escalate — rather than trying and hoping.
    //
    // Every method here has a way of appearing to work and doing nothing,
    // and the worst of them was introduced by tidying this code up. Qwen
    // marks its send control disabled with a CSS class rather than the
    // `disabled` attribute, so Playwright's own actionability check reads
    // it as enabled and clicks it perfectly happily. The click lands, the
    // button does nothing, and the turn then sits for ninety seconds before
    // reporting that the send did not land. It never left.
    //
    // So the question is not "did the click throw" but "did the message
    // go", and the page answers that plainly: Qwen empties the composer and
    // mounts the message. Asking that after each attempt turns a silent
    // no-op into either a send or an honest failure in seconds.
    const minesBefore = (await withTimeout(
      page.$eval(USER_MESSAGE, (els) => els.length),
      "counting my messages"
    ).catch(() => 0)) as number;
    const landed = async (): Promise<boolean> => {
      await page.waitForTimeout(600);
      return (await withTimeout(
        page.evaluate(
          `(() => {
            const el = document.querySelector(${JSON.stringify(COMPOSER)});
            const mine = document.querySelectorAll(${JSON.stringify(USER_MESSAGE)}).length;
            return (el && el.value.length === 0) || mine > ${minesBefore};
          })()`
        ),
        "checking the send landed"
      ).catch(() => false)) as boolean;
    };

    // Playwright's click first: a real input event, at the real position.
    const why = await page
      .click(SEND_BUTTON, { timeout: 8_000 })
      .then(() => null)
      .catch((e: Error) => e.message.split(String.fromCharCode(10))[0].slice(0, 120));
    if (await landed()) return;

    // A click dispatched inside the page. Qwen's menus ignore these — they
    // listen for pointer events — but the send control is an ordinary
    // button and answers to it, measured on the live page.
    const inPage = (await withTimeout(
      page.evaluate(
        `(() => { const b = document.querySelector(${JSON.stringify(SEND_BUTTON)}); if (!b) return "absent"; b.click(); return "clicked"; })()`
      ),
      "clicking send inside the page"
    ).catch(() => "threw")) as string;
    if (await landed()) {
      logger.warn("qwen", "the send button click did not take; the in-page click did", { why, inPage });
      return;
    }

    await page.keyboard.press("Enter").catch(() => {});
    if (await landed()) {
      logger.warn("qwen", "neither click sent the turn; Enter did", { why, inPage });
      return;
    }

    // Nothing moved the message. Failing here costs seconds and says what
    // happened; the alternative is the ninety-second wait this replaced,
    // ending in a sentence that blames a send which never occurred.
    throw new QwenError(
      "Qwen's composer would not send the turn — the send control did not respond and neither did Enter.",
      "composer-refused"
    );
  };

  await submit();
  logger.info("qwen", "turn: sent, waiting for the reply", { setupMs: Date.now() - started });

  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  /** A line every half minute, so a long wait is legible rather than silent. */
  let lastBeat = Date.now();
  let last: string | null = null;
  let quiet = 0;
  let recovered = false;
  let lastChange = Date.now();
  /** When this stretch of claimed work began; 0 when it is not claiming. */
  let generatingSince = 0;
  let lastServiceCheck = Date.now();
  let sawGenerating = false;
  /** One reload-and-resend is a recovery; two in a turn is a loop. */
  let resent = false;

  /**
   * Reload, let the page settle, and send the turn again.
   *
   * Shared by the two ways a turn can arrive somewhere that cannot answer
   * it — a sign-in prompt over a live session, and a guest conversation —
   * because the remedy is the same and a person performs it by hand as
   * "just send it again".
   *
   * It waits for the composer rather than a fixed pause. The working
   * hypothesis for how a signed-in browser reaches a guest chat at all is
   * that the send arrived before Qwen had applied the session to the page,
   * and a timer long enough on one machine is short on another.
   */
  const recoverAndResend = async (why: string, detail: Record<string, unknown>) => {
    resent = true;
    logger.warn("qwen", why, detail);
    await gotoChat(page);
    await page
      .waitForSelector(COMPOSER, { timeout: 20_000 })
      .catch(() => logger.warn("qwen", "the composer did not come back after the reload"));
    await page.waitForTimeout(2_500);
    // Ask before spending the second attempt. The page has just reloaded,
    // so if the header is offering Log in there is nothing wrong with the
    // send and nothing to be gained by repeating it - the session is gone,
    // and the useful thing is to say so now rather than after another
    // silence window spent waiting on a guest conversation that will never
    // answer. This is the check the driver did not have when the first
    // recovery was written; it had to send and wait to find out.
    if ((await askQwen(page)) === "dead") {
      throw new QwenError(
        "Qwen is asking this browser to sign in, so the message could not be sent. Sign in again from the account menu.",
        "signed-out"
      );
    }
    // The reload emptied the composer, so the turn has to go again - the
    // first attempt never reached the model.
    await submit();
    lastChange = Date.now();
  };
  while (Date.now() < deadline) {
    try {
      // Stop means stop. Without this the signal is accepted and ignored:
      // the UI shows the turn ended while the page writes on, and the next
      // turn begins behind an answer still being written.
      if (opts.signal?.aborted) {
        await stopGenerating(page);
        throw new QwenError("interrupted", "interrupted");
      }
      await page.waitForTimeout(POLL_MS);
      const now = await readLast(page);
      if (Date.now() - lastBeat > 30_000) {
        lastBeat = Date.now();
        logger.info("qwen", "turn: still waiting", {
          seconds: Math.round((Date.now() - started) / 1000),
          generating: now.generating,
          replyChars: now.text.length,
          url: page.url(),
        });
      }
      if (now.generating) {
        sawGenerating = true;
        if (!stopSignalSeen) {
          stopSignalSeen = true;
          logger.info("qwen", "the progress indicator is readable on this page");
        }
        if (!generatingSince) generatingSince = Date.now();
        // Working, therefore not silent. The silence window exists to catch
        // a send that never arrived, and a page showing its own stop control
        // has plainly received one - so the clock belongs to the answer, not
        // to the wait for it. Without it, a model that thinks for more than
        // ninety seconds before writing is reported as a send that did not
        // land, because reply text is what the clock watches and thinking
        // produces none.
        //
        // Bounded, though, because "generating" is only "the Stop control is
        // on the page" and that control can be left behind - by an answer
        // interrupted mid-stream most of all. A stale one is
        // indistinguishable from deep thought and says so for ever, which
        // made the silence window unreachable and ran every later turn to
        // the full reply timeout. See `thinkingStillCredible`.
        if (thinkingStillCredible(true, now.text.length > 0, Date.now() - generatingSince)) {
          lastChange = Date.now();
        }
      } else {
        generatingSince = 0;
      }
      const fresh = now.count > before.count || now.text !== before.text;
      if (!fresh || !now.text) {
        // Before anything else: has the page dropped into a guest
        // conversation? Nothing sent from there is ever answered, so there
        // is nothing to wait for and ninety seconds of waiting only delays
        // the one sentence that helps.
        if (isGuestChat(page.url())) {
          // A guest conversation is not proof the session has gone, and
          // treating it as proof was wrong: turns kept succeeding in
          // between the failures, which an expired session cannot do.
          // Something puts a signed-in browser there intermittently — most
          // likely a send that arrives before Qwen has applied the session
          // to a freshly loaded page — and the remedy is the one a person
          // uses without thinking, which is to send it again.
          //
          // Only when it survives that is the session actually gone.
          if (!resent) {
            await recoverAndResend("a guest conversation on a live session; reloading once", {
              url: page.url(),
            });
            continue;
          }
          throw new QwenError(
            "Qwen kept this browser in a signed-out guest chat even after reloading, so the message could not be answered. The session has expired — sign in again from the account menu.",
            "signed-out"
          );
        }
        // Before waiting the window out: is the page already saying why
        // nothing is coming? The login wall is the common one, and it is
        // readable in a second rather than in ninety.
        if (!last && Date.now() - lastServiceCheck > SERVICE_CHECK_MS) {
          lastServiceCheck = Date.now();
          const said = await serviceMessage(page);
          if (said && said.code !== "signed-out") {
            throw new QwenError(`Qwen says: ${said.text}`, said.code);
          }
          if (said) {
            // A sign-in prompt on the page is not proof of a signed-out
            // profile, and believing it was is how this reported people
            // signed out who were not. The page is prose; the token in the
            // profile's own storage is the fact, and this driver asks the
            // fact before it repeats the prose. Twice before, this codebase
            // has had to learn the same thing — advice text read back as a
            // throttle, advice text read back as fatal — and both are
            // written up in backoff.ts.
            //
            // Qwen's page shows that wording in more than one situation: a
            // genuinely signed-out profile, an expired session, and a promo
            // modal offering credits to someone perfectly signed in. Only
            // the first is worth sending anybody to the sign-in button.
            const verdict = verdictForPrompt(await sessionState(page), resent);
            if (verdict === "signed-out") {
              logger.warn("qwen", "no session in the profile; reporting signed out", {
                url: page.url(),
                said: said.text.slice(0, 120),
              });
              throw new QwenError(
                "The browser profile is signed out of Qwen, so the message went nowhere. Sign in from the account menu, then send again.",
                "signed-out"
              );
            }
            if (verdict === "reload") {
              // A session in hand and a sign-in prompt on screen: the page
              // is wrong about itself, or is showing something that merely
              // reads like a wall. Same remedy as a guest chat.
              await recoverAndResend("a sign-in prompt over a live session; reloading once", {
                said: said.text.slice(0, 120),
              });
              continue;
            }
            if (verdict === "expired") {
              // Twice now, with a token still in place. Most likely expired:
              // the shape is all `isSignedIn` can check, and a stale JWT has
              // the shape of a fresh one. Retryable rather than fatal, and
              // named for what it is so nobody goes hunting a driver bug.
              throw new QwenError(
                "Qwen asked for a sign-in even though the profile still holds a session — it has most likely expired. Signing in again from the account menu will clear it.",
                "signed-out"
              );
            }
            // Unreadable: no verdict. Say nothing and keep waiting; the
            // silence window below is what ends a turn nothing answers.
          }
        }
        // A page that has never shown its Stop control is a page whose
        // "working" signal we cannot read, and thinking then looks exactly
        // like silence. See `silenceWindowMs`.
        const window = silenceWindowMs(stopSignalSeen);
        if (Date.now() - lastChange > window) {
          // Only "absent" sends anyone to the sign-in button. A read that
          // failed says nothing about the session, and the line below —
          // "the send did not land" — is the honest answer for both a live
          // session and a storage that would not answer.
          if ((await sessionState(page)) === "absent") {
            logger.warn("qwen", "no session in the profile after the silence window", {
              url: page.url(),
            });
            throw new QwenError(
              "The browser profile is signed out of Qwen, so the message went nowhere. Sign in from the account menu, then send again.",
              "signed-out"
            );
          }
          // Not "the send did not land": `submit` verified the message
          // reached the page before this wait began. What did not arrive is
          // the answer, and saying so sends people to look in the right
          // place.
          throw new QwenError(
            `Qwen took the message but produced no answer within ${Math.round(window / 1_000)}s.` +
              (stopSignalSeen ? "" : " OnFlip could not see Qwen's own progress indicator on this page, so it waited longer than usual.") +
              " The session is still valid; sending again usually works.",
            "send-not-landed"
          );
        }
        continue;
      }
      lastChange = Date.now();
      if (now.text === last) quiet++;
      else {
        quiet = 0;
        // Only on a change, so a settled answer is not re-emitted while the
        // loop confirms it has stopped growing.
        opts.onProgress?.(now.text);
      }
      last = now.text;
      // The button is the signal and the stillness is only the backstop.
      // `sawGenerating` matters: on a fast answer the whole generation can
      // fall between two polls, and without it a reply that was never seen
      // mid-flight would wait out the settle window for nothing.
      if (!now.generating && (sawGenerating || quiet >= SETTLE_POLLS)) {
        // One more poll after the button goes, because the last frame of
        // text can land just after it.
        await page.waitForTimeout(POLL_MS);
        const settled = await readLast(page);
        if (settled.text && settled.text !== last) {
          last = settled.text;
          opts.onProgress?.(last);
        }
        break;
      }
      // Still generating, and the text has not moved for a long time.
      //
      // Deliberately generous, and deliberately not the settle window: while
      // Stop is on screen the page says it is still writing, and believing
      // the stillness instead would cut an answer off mid-pause. A model that
      // thinks for twenty seconds between paragraphs is doing its job. This
      // exists only for the other case — a Stop control that never goes away,
      // which would otherwise hold the turn to the ten-minute deadline with a
      // complete answer already on screen.
      if (quiet * POLL_MS >= STUCK_STOP_MS) {
        logger.warn("qwen", "the stop control never went away; taking the answer as it stands", {
          quietMs: quiet * POLL_MS,
          chars: last.length,
        });
        break;
      }
    } catch (e) {
      // A renderer that died mid-answer. The turn was already sent, so this
      // reopens and reads rather than sending again — a resend would ask the
      // model the same thing twice and run whatever it answered twice.
      const message = e instanceof Error ? e.message : String(e);
      if (recovered || !/crash|Target closed|Session closed|has been closed/i.test(message)) throw e;
      recovered = true;
      logger.warn("qwen", "the page died mid-answer; reopening to read the reply", {
        error: message.slice(0, 120),
      });
      await closeBrowser();
      page = await chatPage(opts);
      await page.waitForTimeout(4_000);
      quiet = 0;
    }
  }
  if (last === null) {
    throw new QwenError("Qwen did not answer before the deadline.");
  }
  noteConversation(page.url());
  const ms = Date.now() - started;
  logger.info("qwen", "turn answered", { chars: last.length, ms });
  return { reply: last, ms };
}

/**
 * The conversation the driver is in, if any.
 *
 * Qwen puts a uuid in the path once a chat has a first message; a fresh one
 * sits at the root. The transport reads this to know whether the thread it
 * has been appending to still exists — if it does not, the whole transcript
 * has to be replayed.
 */
let conversationId: string | null = null;
let pendingNewChat = false;

export function currentConversationId(): string | null {
  return conversationId;
}

/** Abandon the current thread; the next send starts a new one. */
export function newChat(): void {
  conversationId = null;
  pendingNewChat = true;
}

function noteConversation(url: string): void {
  const id = conversationIdFrom(url);
  if (id && id !== conversationId) {
    conversationId = id;
    logger.info("qwen", "conversation", { id });
  }
}

/**
 * What this driver needs the page to keep offering.
 *
 * The services redesign their own pages without telling anyone and the
 * breakage is silent by nature: a click that finds nothing does nothing.
 * DeepSeek unified three modes into one on 14 September 2026 and OnFlip went
 * on offering all three, each doing nothing, because nothing was watching.
 *
 * `min` is what has to be there. `want` is what should be but whose absence
 * is a degradation rather than a break — the model picker going missing
 * costs a setting, not a turn.
 */
const QWEN_CONTRACT: {
  key: string;
  selector: string;
  min: number;
  what: string;
  want?: boolean;
}[] = [
  { key: "composer", selector: COMPOSER, min: 1, what: "the box a turn is typed into" },
  // Send is deliberately NOT here, and the reason is the whole point of this
  // contract existing.
  //
  // Qwen mounts the send control only once the composer has something in it
  // — measured: zero on an empty composer, one with a character typed. A
  // census runs against a page nobody is typing into, so asserting it means
  // reporting "Qwen's page has changed: sending will fail" on every single
  // run, while sending works perfectly. That happened, on the first live
  // turn, and it is exactly the crying-wolf failure this function's own
  // comment warns about.
  //
  // The send control does get checked, every turn, by the code that depends
  // on it: `sendTurn` clicks it and logs `the send button was not clickable`
  // when it has to fall back to Enter. That is a real signal at the moment it
  // matters, rather than a guess made when nothing is being sent.
  {
    key: "modelPicker",
    selector: '[aria-label="Select Model"]',
    min: 1,
    what: "the model chooser",
    want: true,
  },
  // New Chat is deliberately absent too. The driver does not click it - it
  // navigates to the chat root, which is what  and 
  // do - so its presence proves nothing and its absence broke nothing. It
  // was in here because it was easy to check, which is not a reason. The
  // first live turn duly reported it missing, from a headless window whose
  // narrower layout had collapsed the sidebar it lives in.
];

/**
 * Hold the live page against the contract above.
 *
 * A report, never a gate: someone whose turn works has no business being
 * stopped by a census of the page it worked on. The assistant selector is
 * deliberately absent from the contract — an empty chat has no replies in
 * it, and failing the check for that would cry wolf on every fresh start.
 */
export async function checkSelectors(): Promise<{
  ok: boolean;
  matches: Record<string, number>;
  detail: string;
}> {
  const matches: Record<string, number> = {};
  try {
    const page = await chatPage();
    for (const rule of QWEN_CONTRACT) {
      matches[rule.key] = (await withTimeout(
        page.$$eval(rule.selector, (els) => els.length),
        `counting ${rule.key}`
      ).catch(() => 0)) as number;
    }
  } catch (e) {
    return {
      ok: false,
      matches,
      detail: `Qwen's page could not be read: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    };
  }
  return judgePageCensus(matches);
}

/**
 * The verdict, split from the looking so it can be tested without a browser.
 *
 * Exported for that reason and for one more: this is the sentence a person
 * reads on the health page when a service has changed its page under them,
 * and it is worth being able to hold it against a census by hand.
 */
export function judgePageCensus(matches: Record<string, number>): {
  ok: boolean;
  matches: Record<string, number>;
  detail: string;
} {
  const missing = QWEN_CONTRACT.filter((r) => (matches[r.key] ?? 0) < r.min);
  const broken = missing.filter((r) => !r.want);
  const degraded = missing.filter((r) => r.want);
  if (!missing.length) {
    return { ok: true, matches, detail: "Qwen's page is as OnFlip expects it." };
  }
  const say = (rules: typeof QWEN_CONTRACT) => rules.map((r) => `${r.key} (${r.what})`).join(", ");
  if (broken.length) {
    return {
      ok: false,
      matches,
      detail: `Qwen's page has changed: OnFlip could not find ${say(broken)}. Sending will fail until this is fixed.`,
    };
  }
  return {
    ok: false,
    matches,
    detail: `Qwen's page has changed: OnFlip could not find ${say(degraded)}. Turns will still work; the setting it drives will not.`,
  };
}

/**
 * The models Qwen offers in its own picker, keyed by OnFlip's slug.
 *
 * Read off the live page rather than a docs list: the picker holds
 * `.wms-list__item` rows with `role="option"` and `aria-selected`, and the
 * label is the row's text.
 */
export const QWEN_MODES: Record<string, string> = {
  "qwen3-plus": "Qwen3.7-Plus",
  "qwen3-max": "Qwen3.8-Max",
};

/** The label to pick for a slug, or "" when there is nothing to choose. */
export function labelFor(slug: string | undefined): string {
  if (!slug) return "";
  return QWEN_MODES[slug] ?? "";
}

/**
 * Choose a model in Qwen's own picker.
 *
 * Best-effort by design and reported by its return value rather than by an
 * exception: a model that could not be switched is a turn answered by the
 * other model, which is worth a log line and not worth failing a send over.
 *
 * Real clicks rather than synthetic ones. Qwen's menus do not open for a
 * dispatched `click()` — measured on the live page, twice — because the
 * component listens for pointer events. Playwright sends real ones.
 */
export async function setModel(label: string): Promise<boolean> {
  if (!label) return false;
  try {
    const page = await chatPage();
    const trigger = '[aria-label="Select Model"]';
    const current = (await withTimeout(
      page.$eval(trigger, (el) => (el as { innerText?: string }).innerText ?? ""),
      "reading the model picker"
    ).catch(() => "")) as string;
    if (current.trim().startsWith(label)) return true;
    await page.click(trigger, { timeout: 5_000 });
    await page.waitForTimeout(600);
    const option = `.wms-list__item[role="option"]:has-text("${label}")`;
    await page.click(option, { timeout: 5_000 });
    await page.waitForTimeout(400);
    logger.info("qwen", "model chosen", { label });
    return true;
  } catch (e) {
    logger.warn("qwen", "could not choose the model", {
      label,
      why: e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : String(e).slice(0, 120),
    });
    return false;
  }
}

/**
 * Attachments, declined out loud.
 *
 * Qwen's composer does take files — there is an upload entry in its own menu
 * — but this driver has not mapped it, and a queue that silently drops what
 * was put in it is the failure worth avoiding. Someone who attaches a
 * screenshot should be told it is not going, not discover it from an answer
 * that ignores it.
 */
let composerWarning: string | null = null;

export function queueAttachments(paths: string[]): void {
  if (!paths.length) return;
  composerWarning =
    paths.length === 1
      ? "Qwen attachments are not supported yet, so the file was not sent."
      : `Qwen attachments are not supported yet, so those ${paths.length} files were not sent.`;
  logger.warn("qwen", "attachments declined", { count: paths.length });
}

export function takeComposerWarning(): string | null {
  const held = composerWarning;
  composerWarning = null;
  return held;
}
