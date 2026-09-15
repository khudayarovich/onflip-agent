import * as fs from "node:fs";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import type { FailureCode } from "../../chatgpt/backoff";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { paceNewChat, paceSend } from "../../chatgpt/backoff";
import {
  ARENA_CHAT_URL,
  ARENA_LAUNCH_ARGS,
  ARENA_ORIGIN,
  arenaProfileDir,
  conversationIdFrom,
  isGuest,
  isSignedIn,
  isUsableChatUrl,
} from "./session";
import {
  CHAT_AREA,
  EXTRACT_REPLY,
  GENERATING_TEXT,
  hasMoved,
  looksFinished,
  normalize,
  type ArenaReading,
} from "./extract";
import { mkdirPrivate } from "../../config";
import { releaseProfileLock } from "../profile-lock";

/**
 * The browser OnFlip drives Arena with.
 *
 * Written after the other three and deliberately in their debt: every rule
 * here that looks over-careful is one of their scars. Page calls are all
 * bounded, because `evaluate` has no timeout and three unbounded ones inside
 * Qwen's send path produced turns that hung with nothing in the log. The
 * page is settled before each send, because a shared page carries the last
 * answer into the next turn. Nowhere-pages are navigated away from, because
 * `startsWith` on an origin turns every one of them into a place the driver
 * can never leave.
 *
 * Two things are Arena's own.
 *
 * It refuses automation it can see. `navigator.webdriver` set means the
 * composer takes the text, the send button enables, and nothing is ever
 * posted — no error, no request, no clue. `ARENA_LAUNCH_ARGS` carries the
 * flag that fixes it, and the session module explains why it is a constant.
 *
 * And it has no stop control. Every other driver here learns that an answer
 * is running from a button; Arena says "Generating..." in the thread and
 * nothing else. That word is absent both before an answer starts and after
 * it ends, so `looksFinished` needs to have seen it at least once before it
 * will call a turn over.
 */

class ArenaError extends Error {
  constructor(
    message: string,
    readonly code?: FailureCode
  ) {
    super(message);
    this.name = "ArenaError";
  }
}

/**
 * The composer, and the control that sends it.
 *
 * Scoped to the form on purpose. Arena keeps a mirror textarea beside the
 * real one for autosizing, and a conversation page carries two more that are
 * hidden — four in total, of which exactly one is in the form and takes
 * input. The placeholder also changes, "Ask anything…" on the home page and
 * "Ask followup…" inside a thread, so it is not something to match on.
 */
const COMPOSER = "form textarea";
/** Arena marks this genuinely disabled, so the attribute can be trusted. */
const SEND_BUTTON = 'button[aria-label="Send message"]';

/**
 * How long any single question to the page may take before it is a failure.
 *
 * `page.evaluate` has no timeout of its own — Playwright's covers clicks and
 * waits, not script evaluation — so one against a wedged renderer waits as
 * long as the process lives. `$$eval` is the same thing under another name,
 * and a `.catch()` on either handles a call that rejects rather than one
 * that never returns. Qwen shipped three of these inside its send path and
 * produced turns stuck on "sending" for ever. Every call in this file goes
 * through here.
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
            new ArenaError(
              `Arena's page stopped answering while ${what} (${Math.round(ms / 1000)}s).`,
              "send-not-landed"
            )
          ),
        ms
      );
    }),
  ]);
}

/**
 * Arena talking, rather than a model answering.
 *
 * Cloudflare sits in front of this site — `cf_clearance` and `__cf_bm` are
 * both in the jar on a first visit — so a challenge page is something this
 * driver will meet. The wordings are matched in English and Russian for the
 * reason the other drivers learned the hard way: these decide whether a turn
 * is retried, and a challenge retried into is a challenge made worse.
 */
const SERVICE_MESSAGES: { pattern: RegExp; code: FailureCode }[] = [
  {
    pattern:
      /verify you are human|checking your browser|just a moment|проверка браузера|подтвердите, что вы человек|минуточку/i,
    code: "refused",
  },
  {
    pattern:
      /rate limit(ed)? (exceeded|reached)|reached rate limit|too many requests|reached .{0,40}limit|limit .{0,25}(has been )?reached|достигл\S* .{0,40}(лимит|предел)|(лимит|предел)\S* .{0,30}достигнут|слишком много запросов/i,
    code: "throttled",
  },
  {
    pattern: /server (is )?busy|something went wrong|сервер занят|что-то пошло не так/i,
    code: "service-error",
  },
];

/** The service's own words in a page's text, or null when it is just a page. */
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

let context: BrowserContext | null = null;
/** Set when the next send should open a fresh conversation. */
let pendingNewChat = false;

function executable(): string | undefined {
  const pick = pickSignInBrowser();
  if (pick && pick.channel !== "chromium" && fs.existsSync(pick.executable)) return pick.executable;
  return undefined;
}

export interface OpenOptions {
  headed?: boolean;
  signal?: AbortSignal;
}

export async function openBrowser(opts: OpenOptions = {}): Promise<BrowserContext> {
  if (context) return context;
  const dir = arenaProfileDir();
  mkdirPrivate(dir);
  // Chromium allows one process per profile directory and refuses the second
  // outright; on macOS the sign-in browser is still alive after its window
  // closes. Shared with the other drivers because the fault is the same.
  await releaseProfileLock(dir, (message, data) => logger.info("arena", message, data));
  logger.info("arena", "opening the browser", { profile: dir, headed: Boolean(opts.headed) });
  context = await chromium.launchPersistentContext(dir, {
    executablePath: executable(),
    headless: !opts.headed,
    viewport: null,
    args: ARENA_LAUNCH_ARGS,
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

async function gotoChat(page: Page): Promise<void> {
  try {
    await page.goto(ARENA_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The same race Qwen's driver documents: a single-page app's own router
    // navigating while this request is in flight. The page usually arrived.
    if (!/interrupted by another navigation|ERR_ABORTED/i.test(message)) throw e;
    await page.waitForTimeout(1_200).catch(() => {});
    if (isUsableChatUrl(page.url())) return;
    throw new ArenaError(
      `Loading Arena was interrupted by another navigation. Retrying. (${message})`,
      "send-not-landed"
    );
  }
}

export async function chatPage(opts: OpenOptions = {}): Promise<Page> {
  const ctx = await openBrowser(opts);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!isUsableChatUrl(page.url())) await gotoChat(page);
  return page;
}

/** What the thread is showing right now. */
async function read(page: Page): Promise<ArenaReading> {
  const raw = await withTimeout(page.evaluate(EXTRACT_REPLY), "reading the reply").catch(() => null);
  return normalize(raw);
}

/** Arena's own words, when the page is showing some. */
async function serviceMessage(page: Page): Promise<{ text: string; code: FailureCode } | null> {
  const body = (await withTimeout(
    page.evaluate('(document.body && document.body.innerText) || ""'),
    "reading the page"
  ).catch(() => "")) as string;
  return matchServiceMessage(body);
}

export function currentConversationId(): string | null {
  const page = context?.pages()[0];
  return page ? conversationIdFrom(page.url()) : null;
}

/** Arena takes no attachments through this driver yet. */
export function queueAttachments(_paths: string[]): void {
  /* nothing to queue */
}

export function takeComposerWarning(): string | null {
  return null;
}

/** The next send opens a new conversation. */
export function reset(): void {
  pendingNewChat = true;
}

export interface SignedInCheck {
  signedIn: boolean;
  account?: string;
  email?: string;
  error?: string;
}

/**
 * Is there an account behind this profile?
 *
 * Asked of the cookie jar rather than the page, which is the whole reason
 * this provider is worth having: the session is two cookies with a
 * thirteen-month life, and reading them needs no render to have finished
 * and no word to be matched in any language.
 *
 * Arena works signed out, so "no account" is not "broken" — but it is worth
 * reporting, because an anonymous visitor has no history and a much smaller
 * allowance.
 */
export async function checkSignedIn(opts: OpenOptions & { tries?: number } = {}): Promise<SignedInCheck> {
  const tries = Math.max(1, opts.tries ?? 1);
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const ctx = await openBrowser(opts);
      const page = await chatPage(opts);
      // The jar is populated as the page loads; a check the instant the
      // document exists can read it before the cookies are set.
      await page.waitForTimeout(1_200);
      const jar = await ctx.cookies(ARENA_ORIGIN);
      if (isSignedIn(jar)) {
        logger.info("arena", "checked the session", { signedIn: true, attempt });
        return { signedIn: true };
      }
      if (attempt === tries) {
        logger.info("arena", "checked the session", {
          signedIn: false,
          guest: isGuest(jar),
          attempt,
        });
        return { signedIn: false };
      }
      await page.waitForTimeout(1_500);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn("arena", "could not check the session", { attempt, error: lastError });
      await closeBrowser().catch(() => {});
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return { signedIn: false, error: lastError };
}

/**
 * Put Arena in the one mode this driver can use.
 *
 * Battle Mode is the default and answers every message twice, anonymously —
 * two models side by side for a person to vote between. That is the site's
 * whole purpose and it is useless to an agent, which needs one answer from a
 * model it can name.
 *
 * Best effort, and reported by its return value rather than by throwing: a
 * mode that could not be switched is a turn answered oddly, which is worth a
 * log line and not worth failing a send over.
 */
export async function setDirectMode(page: Page): Promise<boolean> {
  try {
    const already = await withTimeout(
      page.evaluate(
        `(() => [...document.querySelectorAll('[role=combobox]')].some(e => /^Direct/i.test((e.innerText||"").trim())))()`
      ),
      "reading the mode"
    );
    if (already) return true;

    // The control is rendered once per breakpoint and only one is clickable.
    for (const combo of await page.$$("[role=combobox], button[aria-haspopup]")) {
      const text = (await combo.innerText().catch(() => "")).trim();
      if (!/Battle|Direct|Side by Side|Agent/i.test(text)) continue;
      if (!(await combo.isVisible().catch(() => false))) continue;
      await combo.click({ timeout: 8_000 }).catch(() => {});
      break;
    }
    await page.waitForTimeout(1_000);
    for (const option of await page.$$("[role=option]")) {
      const text = (await option.innerText().catch(() => "")).trim();
      if (!/^Direct/i.test(text)) continue;
      await option.click({ timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(1_200);
      logger.info("arena", "switched to Direct mode");
      return true;
    }
    logger.warn("arena", "could not find Direct in the mode menu");
    return false;
  } catch (e) {
    logger.warn("arena", "could not set the mode", {
      error: e instanceof Error ? e.message.split(String.fromCharCode(10))[0].slice(0, 120) : String(e),
    });
    return false;
  }
}

/**
 * Make sure a turn does not begin behind the last one's answer.
 *
 * The page is shared between turns, so an answer still being written is
 * still being written when the next message goes. Arena has no stop control
 * to press, so the only move is to wait for it — briefly — and reload if it
 * will not settle.
 */
async function settlePage(page: Page): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const now = await read(page);
    if (!now.generating) return;
    await page.waitForTimeout(1_000);
  }
  logger.warn("arena", "the page was still generating when a turn began; reloading");
  await gotoChat(page);
  await page
    .waitForSelector(COMPOSER, { timeout: 20_000 })
    .catch(() => logger.warn("arena", "the composer did not come back after settling"));
}

export const SILENCE_MS = 90_000;
const POLL_MS = 400;

export interface SendResult {
  reply: string;
  /** How long the answer took to settle, for the log. */
  ms: number;
}

/**
 * Send a turn and wait for the answer.
 *
 * The shape is Qwen's, minus its one advantage: there is no stop control, so
 * the end of an answer is "Arena stopped saying Generating and left text
 * behind". `looksFinished` holds that rule and is tested on its own, because
 * getting it wrong by one condition hands back an empty reply — which reads
 * downstream as a model that answered with nothing.
 */
export async function sendTurn(
  text: string,
  opts: OpenOptions & {
    timeoutMs?: number;
    onProgress?: (partial: string) => void;
  } = {}
): Promise<SendResult> {
  const started = Date.now();
  // A floor between messages, for the reason ChatGPT's transport keeps one:
  // a tool loop can come straight back and a person cannot, and a site with
  // Cloudflare in front is watching for exactly that.
  await paceSend(opts.signal);
  logger.info("arena", "turn: opening the page", { chars: text.length });
  const page = await chatPage(opts);

  if (pendingNewChat) {
    pendingNewChat = false;
    await paceNewChat(opts.signal);
    await gotoChat(page);
    await page
      .waitForSelector(COMPOSER, { timeout: 20_000 })
      .catch(() => logger.warn("arena", "the composer did not appear on the new chat"));
    await page.waitForTimeout(1_200);
  }

  // Battle Mode answers twice, anonymously. One answer from a named model is
  // the only thing an agent can use.
  await setDirectMode(page);
  // Never begin behind the previous answer.
  await settlePage(page);

  const before = await read(page);

  const submit = async (): Promise<void> => {
    await page.click(COMPOSER).catch(() => {
      /* focus is a nicety; the fill below is what matters */
    });
    // The native setter, because React owns the textarea's value and writing
    // `el.value` leaves its state holding the old string with Send disabled.
    const fill = `(() => {
      const el = document.querySelector(${JSON.stringify(COMPOSER)});
      if (!el) return -1;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value.length;
    })()`;
    const accepted = (await withTimeout(page.evaluate(fill), "filling the composer")) as number;
    if (accepted < 0) throw new ArenaError("Arena's composer was not on the page.", "composer-refused");
    if (accepted < text.length) {
      logger.warn("arena", "the composer truncated the turn", { sent: text.length, accepted });
    }
    await page.waitForTimeout(250);

    // Try, then CHECK. Arena marks Send genuinely `disabled`, so unlike
    // Qwen a click on a dead button throws rather than silently doing
    // nothing - but the question that matters is still whether the message
    // went, and the page answers it by emptying the composer.
    const landed = async (): Promise<boolean> => {
      await page.waitForTimeout(600);
      return (await withTimeout(
        page.evaluate(
          `(() => {
            const el = document.querySelector(${JSON.stringify(COMPOSER)});
            return !el || el.value.length === 0;
          })()`
        ),
        "checking the send landed"
      ).catch(() => false)) as boolean;
    };

    // Wait for the control to become usable before pressing it. Arena marks
    // Send genuinely `disabled`, so Playwright will wait out its whole
    // timeout on a button that React has not re-enabled yet - and report
    // that as the send failing, when it had not been tried.
    await page
      .waitForSelector(`${SEND_BUTTON}:not([disabled])`, { timeout: 10_000 })
      .catch(() => logger.warn("arena", "the send control did not become usable"));
    const why = await page
      .click(SEND_BUTTON, { timeout: 8_000 })
      .then(() => null)
      .catch((e: Error) => e.message.split(String.fromCharCode(10))[0].slice(0, 120));
    if (await landed()) return;

    // Enter, which is what a person presses.
    await page.keyboard.press("Enter").catch(() => {});
    if (await landed()) {
      logger.warn("arena", "the send button did not take; Enter did", { why });
      return;
    }
    throw new ArenaError(
      `Arena would not accept the message${why ? ` (${why})` : ""}.`,
      "send-not-landed"
    );
  };

  await submit();
  logger.info("arena", "turn: sent, waiting for the reply", { setupMs: Date.now() - started });

  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  let lastChange = Date.now();
  let lastBeat = Date.now();
  let sawGenerating = false;
  let sent = "";

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new ArenaError("interrupted", "interrupted");
    await page.waitForTimeout(POLL_MS);
    const now = await read(page);

    if (Date.now() - lastBeat > 30_000) {
      lastBeat = Date.now();
      logger.info("arena", "turn: still waiting", {
        seconds: Math.round((Date.now() - started) / 1000),
        generating: now.generating,
        replyChars: now.text.length,
        url: page.url(),
      });
    }

    if (now.generating) {
      sawGenerating = true;
      lastChange = Date.now();
    }
    if (hasMoved(before, now)) {
      lastChange = Date.now();
      if (now.text && now.text !== sent) {
        sent = now.text;
        opts.onProgress?.(now.text);
      }
    }

    if (looksFinished(before, now, sawGenerating)) {
      logger.info("arena", "turn answered", {
        ms: Date.now() - started,
        replyChars: now.text.length,
      });
      return { reply: now.text, ms: Date.now() - started };
    }

    if (Date.now() - lastChange > SILENCE_MS) {
      // Before blaming the send: is the page already saying why?
      const said = await serviceMessage(page);
      if (said) throw new ArenaError(`Arena says: ${said.text}`, said.code);
      throw new ArenaError(
        `Arena took the message but produced no answer within ${SILENCE_MS / 1_000}s.`,
        "send-not-landed"
      );
    }
  }
  throw new ArenaError(
    `Arena was still working after ${Math.round((Date.now() - started) / 1000)}s and the reply budget ran out.`,
    "service-error"
  );
}

/**
 * What the page must still have for this driver to work.
 *
 * The health check, and a list worth keeping short: each of these is load
 * bearing, and a redesign that moves one is a driver that fails in a way
 * nobody can read from the outside.
 */
const ARENA_CONTRACT: { key: string; selector: string }[] = [
  { key: "chat area", selector: CHAT_AREA },
  { key: "composer", selector: COMPOSER },
  { key: "send", selector: SEND_BUTTON },
];

export async function checkSelectors(): Promise<{
  ok: boolean;
  matches: Record<string, number>;
  detail: string;
}> {
  const matches: Record<string, number> = {};
  try {
    const page = await chatPage();
    await page.waitForTimeout(1_500);
    for (const rule of ARENA_CONTRACT) {
      matches[rule.key] = (await withTimeout(
        page.$$eval(rule.selector, (els) => els.length),
        `counting ${rule.key}`
      ).catch(() => 0)) as number;
    }
  } catch (e) {
    return {
      ok: false,
      matches,
      detail: `Arena's page could not be read (${e instanceof Error ? e.message.split(String.fromCharCode(10))[0].slice(0, 120) : String(e)}).`,
    };
  }
  const missing = ARENA_CONTRACT.filter((r) => !matches[r.key]).map((r) => r.key);
  return {
    ok: missing.length === 0,
    matches,
    detail: missing.length
      ? `Arena's page is missing: ${missing.join(", ")}. The site has probably changed.`
      : "Arena's page has everything this driver needs.",
  };
}
