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
      /verify you are human|security verification|checking your browser|just a moment|проверка браузера|проверка безопасности|подтвердите, что вы человек|минуточку/i,
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

/**
 * How Arena's browser must be shaped, which stopped being a preference.
 *
 * Measured on one signed-in profile, minutes apart, same account and same
 * message: headless, every generation dies server-side with Arena's own
 * "Something went wrong while generating the response"; headed, it answers
 * in twenty seconds. The send is accepted either way and "Generating..."
 * shows either way - the kill is silent sabotage at the end, which is what
 * made it read as the app hanging rather than the service refusing.
 *
 * So the driver runs headed, with the window parked far off the desktop.
 * Verified: at -32000,-32000 nothing is visible, the page still reports
 * itself visible, and the same turn that died headless answered in
 * fourteen seconds. macOS may clamp the position differently - the worst
 * case there is a window somebody can see, which still answers, and that
 * beats invisible and dead.
 *
 * Linux keeps headless: a headed window needs a display server that a box
 * running an agent may not have, and no Arena build ships for it anyway.
 */
export function arenaWindow(
  headed: boolean,
  platform: NodeJS.Platform = process.platform
): { headless: boolean; args: string[] } {
  if (headed) return { headless: false, args: [...ARENA_LAUNCH_ARGS] };
  if (platform === "linux") return { headless: true, args: [...ARENA_LAUNCH_ARGS] };
  return {
    headless: false,
    args: [...ARENA_LAUNCH_ARGS, "--window-position=-32000,-32000", "--window-size=1280,900"],
  };
}

/** True while this run's window is parked off the desktop. */
let windowParked = false;

/**
 * How long a person gets to answer Arena's human check before the turn
 * fails. Four minutes: a checkbox takes seconds, but the person has to
 * notice a window appearing first.
 */
const CHALLENGE_WAIT_MS = 4 * 60_000;

/**
 * Is the page showing a human check?
 *
 * The widget is a Cloudflare Turnstile iframe, looked for by its own
 * hostname rather than by wording; the text patterns are the fallback for
 * the interstitial variants that render as a page instead.
 */
export const CHALLENGE_SCRIPT = `(() => {
  if (document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]')) return true;
  const t = (document.body.innerText || "");
  return /verify you are human|security verification|checking your browser|just a moment|подтвердите, что вы человек|проверка безопасности/i.test(t);
})()`;

async function challengeUp(page: Page): Promise<boolean> {
  return (await withTimeout(page.evaluate(CHALLENGE_SCRIPT), "looking for a human check").catch(
    () => false
  )) as boolean;
}

/** Move the browser window; a window that cannot be moved is still a window. */
async function moveWindow(page: Page, left: number, top: number): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left, top, windowState: "normal" },
    });
    await session.detach().catch(() => {});
  } catch {
    /* best effort */
  }
}

/**
 * A human check is the one thing in this driver only a person can do.
 *
 * Reported from a Mac: the send opened a security verification with a
 * captcha, and that was the end of it - the driver read it as a refusal
 * and the turn just died. But a challenge is not a refusal: it is a
 * request, and the person it is addressed to is sitting right there. So
 * the window - parked off the desktop on Windows - is brought on screen,
 * the person clicks the checkbox, and the turn carries on. Verified that
 * the CDP window move works in both directions before shipping it.
 *
 * Returns false when no challenge is showing, true when one was answered;
 * throws when four minutes pass with the checkbox unclicked, with the one
 * error message that says what to actually do.
 */
async function waitOutChallenge(page: Page, signal?: AbortSignal): Promise<boolean> {
  if (!(await challengeUp(page))) return false;
  logger.warn("arena", "Arena is asking for a human verification; bringing the window on screen");
  await moveWindow(page, 120, 80);
  const deadline = Date.now() + CHALLENGE_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ArenaError("interrupted", "interrupted");
    await page.waitForTimeout(2_000);
    if (!(await challengeUp(page))) {
      logger.info("arena", "the human check was answered; carrying on");
      await page.waitForTimeout(1_500);
      if (windowParked) await moveWindow(page, -32_000, -32_000);
      return true;
    }
  }
  throw new ArenaError(
    "Arena is asking for a human verification (captcha). The Arena browser window is on your screen - complete the check there, then send your message again.",
    "refused"
  );
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
  const window = arenaWindow(Boolean(opts.headed));
  windowParked = !window.headless && window.args.some((a) => a.startsWith("--window-position=-"));
  context = await chromium.launchPersistentContext(dir, {
    executablePath: executable(),
    headless: window.headless,
    viewport: null,
    args: window.args,
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
/**
 * Choose a row of an open Arena menu by the text on it.
 *
 * The menus carried `role=option` when this driver was written, and that
 * is still tried first. Arena has since rebuilt them: the rows are plain
 * paragraphs inside a `[data-state=open]` portal, with no option role
 * anywhere - measured on a live page, where the old scan found nothing and
 * every fresh session stayed in Battle Mode because of it. The fallback
 * finds the visible leaf whose text is the wanted line and clicks it with
 * the mouse at its coordinates, because this menu selects on real pointer
 * events rather than on a synthetic element.click().
 */
async function clickMenuRow(page: Page, wanted: string): Promise<boolean> {
  for (const option of await page.$$("[role=option]")) {
    const text = (await option.innerText().catch(() => "")).trim();
    if (!text.split(String.fromCharCode(10)).some((line) => line.trim() === wanted)) continue;
    await option.click({ timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  const spot = (await withTimeout(
    page.evaluate(
      `(() => {
        for (const root of document.querySelectorAll('[data-state=open]')) {
          for (const leaf of root.querySelectorAll('*')) {
            if (leaf.children.length !== 0) continue;
            if ((leaf.textContent || '').trim() !== ${JSON.stringify(wanted)}) continue;
            if (!leaf.offsetWidth && !leaf.offsetHeight) continue;
            const r = leaf.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      })()`
    ),
    "finding the menu row"
  ).catch(() => null)) as { x: number; y: number } | null;
  if (!spot) return false;
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(1_000);
  return true;
}

export async function setDirectMode(page: Page): Promise<boolean> {
  try {
    // A cold first load — fresh profile, no cache, Cloudflare handshake —
    // paints the combobox seconds before it works. Clicking it then is a
    // silent no-op, and one silent no-op here left every fresh session in
    // Battle Mode: two anonymous answers the extractor cannot read, which
    // surfaced as a turn stuck at "sending" forever. So the switch is
    // retried on a page that has had another moment, rather than trusted
    // to a single pass timed for a warm one.
    await page.waitForSelector("[role=combobox]", { timeout: 12_000 }).catch(() => {});
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await page.waitForTimeout(2_000);
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
      if (!(await clickMenuRow(page, "Direct"))) {
        logger.warn("arena", "could not find Direct in the mode menu", { attempt });
        continue;
      }
      // Believe the control, not the click: the row was chosen by its
      // coordinates, and a menu that moved would make this a silent no-op.
      const now = (await withTimeout(
        page.evaluate(
          `(() => [...document.querySelectorAll('[role=combobox]')].some(e => /^Direct/i.test((e.innerText||"").trim())))()`
        ),
        "re-reading the mode"
      ).catch(() => false)) as boolean;
      if (now) {
        logger.info("arena", "switched to Direct mode", { attempt });
        return true;
      }
      logger.warn("arena", "clicked Direct but the mode did not change", { attempt });
    }
    logger.warn("arena", "the page never took the Direct switch; sending anyway");
    return false;
  } catch (e) {
    logger.warn("arena", "could not set the mode", {
      error: e instanceof Error ? e.message.split(String.fromCharCode(10))[0].slice(0, 120) : String(e),
    });
    return false;
  }
}

/**
 * The label Arena's picker shows for a slug.
 *
 * Its slugs are the upstream vendors' own — `gpt-5.2`, `glm-5` — and the
 * picker lists them verbatim, so a slug is its own label. The exception is
 * Arena's default router, which is called "Max" on screen and needs a slug
 * of its own here because `max` alone would be nobody's model name.
 */
export function labelFor(slug: string | undefined): string {
  if (!slug) return "";
  return slug === "arena-max" ? "Max" : slug;
}

/**
 * Choose a model in Arena's own picker.
 *
 * Best effort, and reported by its return value rather than by throwing: a
 * model that could not be switched is a turn answered by a different model,
 * which is worth a log line and not worth failing a send over.
 *
 * Worth having at all because the alternative is a menu that lies. OnFlip
 * lists models for this service, and a list somebody can pick from that
 * changes nothing is the same fault as an "always allow" that quietly
 * allows something else.
 *
 * The picker belongs to the conversation, so this is called while a chat is
 * still empty. Under one-shot that is every turn, which is the one thing
 * one-shot makes easier.
 */
export async function setModel(label: string): Promise<boolean> {
  if (!label) return false;
  try {
    const page = await chatPage();
    const already = await withTimeout(
      page.evaluate(
        `(() => [...document.querySelectorAll('[role=combobox]')].some(e => (e.innerText||"").trim().split(String.fromCharCode(10))[0] === ${JSON.stringify(label)}))()`
      ),
      "reading the model picker"
    );
    if (already) return true;

    // The model control is the combobox that is not the mode one, and only
    // the copy rendered for this breakpoint can be clicked.
    let opened = false;
    for (const combo of await page.$$("[role=combobox], button[aria-haspopup]")) {
      const text = (await combo.innerText().catch(() => "")).trim();
      if (!text || /^(Direct|Battle|Side by Side|Agent)/i.test(text)) continue;
      if (!(await combo.isVisible().catch(() => false))) continue;
      await combo.click({ timeout: 8_000 }).then(() => {
        opened = true;
      }).catch(() => {});
      if (opened) break;
    }
    if (!opened) {
      logger.warn("arena", "the model picker would not open");
      return false;
    }
    await page.waitForTimeout(1_000);

    if (await clickMenuRow(page, label)) {
      logger.info("arena", "model chosen", { label });
      return true;
    }
    logger.warn("arena", "that model is not in Arena's picker", { label });
    // Close the menu rather than leaving it over the composer.
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  } catch (e) {
    logger.warn("arena", "could not set the model", {
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
/**
 * The dialog that eats a session's first message.
 *
 * Reported from a Mac as a turn stuck at "sending" forever, and reproduced
 * on a fresh profile: pressing Send does not send. It opens Arena's Terms
 * of Use dialog - "Agree" and "Close" - and holds the message, with the
 * composer still full and no request made. A person sees the dialog and
 * clicks; a headless driver sees nothing and waits for a reply that will
 * never come. Profiles that agreed long ago never show it, which is why
 * every turn on the machine this was built on kept working while every
 * turn on a fresh sign-in hung.
 *
 * Clicking Agree posts the consent and the held send then proceeds by
 * itself - measured: update-tou-consent, then the chat request, with no
 * second press needed. Matched on the dialog's own words and the button's,
 * scoped to the dialog so nothing else on the page can be clicked by it.
 */
export const ACCEPT_TERMS = `(() => {
  for (const d of document.querySelectorAll('[role=dialog], [role=alertdialog], dialog')) {
    if (!(d.innerText || "").includes("Terms of Use")) continue;
    const agree = [...d.querySelectorAll("button")].find((b) => /agree/i.test(b.innerText || ""));
    if (agree) { agree.click(); return true; }
  }
  return false;
})()`;

async function acceptTerms(page: Page): Promise<boolean> {
  const clicked = (await withTimeout(page.evaluate(ACCEPT_TERMS), "answering the Terms dialog").catch(
    () => false
  )) as boolean;
  if (!clicked) return false;
  logger.info("arena", "accepted the Terms of Use dialog that held the send");
  // The consent posts and the held message goes; give both a moment.
  await page.waitForTimeout(1_500);
  return true;
}

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

  // Nor behind a human check: everything below assumes the page is Arena's,
  // and a challenge on screen means it is Cloudflare's until somebody clicks.
  if (await waitOutChallenge(page, opts.signal)) await settlePage(page);

  const before = await read(page);

  const submit = async (): Promise<void> => {
    // Focus is a nicety; the native-setter fill below is what actually puts
    // the text in. But a bare `click` carries Playwright's default thirty
    // second actionability timeout, so a composer that is momentarily
    // covered - which is exactly what a conversation page does while it
    // settles - costs half a minute per turn before the catch swallows it.
    // Measured: a second turn spent thirty seconds here and then worked.
    await page.click(COMPOSER, { timeout: 2_500 }).catch(() => {});
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

    // A session's first send does not send: it opens the Terms of Use
    // dialog and holds the message, and answering it is what lets go. The
    // held send resumes on its own schedule, not the click's — measured a
    // couple of seconds — so the check is a patient poll, not one look.
    if (await acceptTerms(page)) {
      for (let i = 0; i < 3; i++) {
        if (await landed()) return;
        await page.waitForTimeout(1_000);
      }
      // And when it does not resume — seen both ways on a live page — the
      // message is still sitting in the composer, so press Send again.
      await page.click(SEND_BUTTON, { timeout: 8_000 }).catch(() => {});
      for (let i = 0; i < 3; i++) {
        if (await landed()) return;
        await page.waitForTimeout(1_000);
      }
    }

    // Enter, which is what a person presses.
    await page.keyboard.press("Enter").catch(() => {});
    if (await landed()) {
      logger.warn("arena", "the send button did not take; Enter did", { why });
      return;
    }
    // Once more before giving up: the dialog can arrive late, and throwing
    // with it on screen turns a one-click formality into a failed turn.
    if (await acceptTerms(page)) {
      for (let i = 0; i < 6; i++) {
        if (await landed()) return;
        await page.waitForTimeout(1_000);
      }
    }
    // Or the click summoned the human check itself. Answered by the person
    // and the message is still in the composer, so press Send again.
    if (await waitOutChallenge(page, opts.signal)) {
      await page.click(SEND_BUTTON, { timeout: 8_000 }).catch(() => {});
      for (let i = 0; i < 3; i++) {
        if (await landed()) return;
        await page.waitForTimeout(1_000);
      }
    }

    // A send that will not land has one more honest explanation: Arena has
    // put Direct mode behind an account, and a signed-out session gets a
    // "Log In or Create Account" dialog where its answer would be. Seen
    // live the day this shipped. Named as what it is, because the generic
    // failure below reads as a bug in the app and this one is a policy.
    const wall = (await withTimeout(
      page.evaluate(
        `(() => {
          for (const d of document.querySelectorAll('[role=dialog], dialog')) {
            if (/log in or create account/i.test(d.innerText || '')) return true;
          }
          return false;
        })()`
      ),
      "checking for a login wall"
    ).catch(() => false)) as boolean;
    if (wall) {
      throw new ArenaError(
        "Arena now asks for an account before it will answer here. Open Settings and sign in to Arena — a signed-out session has stopped being enough for it.",
        "anonymous"
      );
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
  /** Polls since a generation finished with an empty reply. */
  let emptyEnds = 0;
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

    // A generation that ENDED with nothing written is not silence - it is
    // Arena's error card, which renders outside the reply container. This
    // used to sit out the whole silence window before looking, so every
    // killed generation cost three minutes instead of five seconds, and
    // three of those in a row read as the app hanging for ten.
    if (sawGenerating && !now.generating && now.text.trim().length === 0) {
      emptyEnds += 1;
      if (emptyEnds === 5) {
        const said = await serviceMessage(page);
        // A refusal that is really a human check is answered, not thrown:
        // the person clicks, the clock restarts, the turn goes on.
        if (said?.code === "refused" && (await waitOutChallenge(page, opts.signal))) {
          emptyEnds = 0;
          lastChange = Date.now();
        } else if (said) {
          throw new ArenaError(`Arena says: ${said.text}`, said.code);
        }
      }
    } else {
      emptyEnds = 0;
    }

    if (Date.now() - lastChange > SILENCE_MS) {
      // Before blaming the send: is the page already saying why?
      const said = await serviceMessage(page);
      if (said?.code === "refused" && (await waitOutChallenge(page, opts.signal))) {
        lastChange = Date.now();
        continue;
      }
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
