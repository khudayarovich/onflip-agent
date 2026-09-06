import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { EXTRACT_REPLY as EXTRACT_REPLY_SCRIPT, toMarkdown } from "./extract";
import {
  DEEPSEEK_CHAT_URL,
  TOKEN_KEY,
  USER_KEY,
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
  fs.mkdirSync(dir, { recursive: true });
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
async function readProfile(page: Page): Promise<{ name?: string; email?: string }> {
  try {
    const raw = (await Promise.race([
      page.evaluate(`(async () => {
        let token = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) || "";
        try { token = JSON.parse(token).value || token; } catch (e) {}
        if (!token) return null;
        const res = await fetch("/api/v0/users/current", {
          credentials: "include",
          headers: { authorization: "Bearer " + token },
        });
        if (!res.ok) return null;
        const body = await res.json();
        const user = body && body.data && body.data.biz_data;
        if (!user) return null;
        return { name: (user.id_profile || {}).name || "", email: user.email || "" };
      })()`),
      new Promise((resolve) => setTimeout(() => resolve(null), 8_000)),
    ])) as { name?: string; email?: string } | null;
    if (!raw) return {};
    return { name: raw.name?.trim() || undefined, email: raw.email?.trim() || undefined };
  } catch {
    return {};
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
        logger.info("deepseek", "checked the session", { signedIn: true, attempt });
        const profile = await readProfile(page);
        return { signedIn: true, account: profile.name, email: profile.email };
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
    await page.goto(DEEPSEEK_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
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
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    try {
      // Stop means stop. Without this the signal was accepted and ignored:
      // the UI showed the turn ended while the loop kept polling and the page
      // kept generating, so the next turn began behind an answer still being
      // written.
      if (opts.signal?.aborted) {
        await stopGenerating(page);
        throw new Error("interrupted");
      }
      await page.waitForTimeout(POLL_MS);
      const now = await readLast(page);
      const fresh = now.count > before.count || now.text !== before.text;
      if (!fresh || !now.text) {
        // Nothing has moved. A reply that has not started at all within the
        // silence window is a failure worth reporting, not something to sit
        // on until the ten-minute deadline while the UI says "working".
        if (Date.now() - lastChange > SILENCE_MS) {
          throw new Error(
            "DeepSeek did not start answering. The page may have signed out, or the send did not land."
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
      await closeBrowser();
      page = await chatPage(opts);
      await page.waitForTimeout(4_000);
      quiet = 0;
    }
  }
  if (last === null) throw new Error("DeepSeek did not answer before the deadline.");
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

/** Abandon the current thread; the next send starts a new one. */
export function newChat(): void {
  conversationId = null;
  pendingNewChat = true;
}

let pendingNewChat = false;

/** Note the conversation from the page's URL, e.g. /a/chat/s/<id>. */
function noteConversation(url: string): void {
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
export async function checkSelectors(): Promise<{
  ok: boolean;
  matches: Record<string, number>;
  detail: string;
}> {
  try {
    const page = await chatPage();
    const matches = (await page.evaluate(
      `({
        composer: document.querySelectorAll("textarea").length,
        assistant: document.querySelectorAll(".ds-markdown.ds-assistant-message-main-content").length,
        codeBlock: document.querySelectorAll(".md-code-block").length,
      })`
    )) as Record<string, number>;
    const ok = matches.composer > 0;
    return {
      ok,
      matches,
      detail: ok
        ? "DeepSeek's composer is on the page."
        : "DeepSeek's composer was not found — the page may have changed, or the profile may be signed out.",
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
 * DeepSeek's three modes: Instant, Expert and Vision.
 *
 * A real radio group above the composer, and the closest thing DeepSeek has
 * to a model picker — so that is what OnFlip presents them as. Identified by
 * `data-model-type`, which is a stable attribute rather than one of the
 * hashed class names everywhere else on that page, with the current choice in
 * `aria-checked`.
 *
 * The catch that shapes the whole design: the group only exists before a
 * conversation's first message. Once anything has been sent it is gone, and
 * the mode is fixed for that thread. So a mode is applied at the start of a
 * chat and never mid-conversation, and changing it starts a new one — which
 * is what the engine already does when the model changes.
 */
export const DEEPSEEK_MODES = {
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
 * Choose a mode, if there is still a chat young enough to choose one for.
 *
 * Answers false when the group is absent, which is the ordinary case
 * mid-conversation rather than a fault — the caller only asks on a fresh
 * chat, and a thread that has already started keeps the mode it was born with.
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
    if (!before.present) return false;
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
