import * as fs from "node:fs";
import { chromium, BrowserContext, Page } from "playwright";
import { logger } from "../../log";
import type { FailureCode } from "../../chatgpt/backoff";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { EXTRACT_REPLY as EXTRACT_REPLY_SCRIPT, normalizeNodes, toMarkdown } from "./extract";
import {
  QWEN_CHAT_URL,
  TOKEN_KEY,
  ROLE_KEY,
  conversationIdFrom,
  isSignedIn,
  qwenProfileDir,
} from "./session";

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

/** Open the chat, turning a lost navigation race into something retryable. */
async function gotoChat(page: Page): Promise<void> {
  try {
    await page.goto(QWEN_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/interrupted by another navigation/i.test(message)) {
      throw new QwenError(
        `Loading the Qwen chat was interrupted by another navigation. Retrying. (${message})`,
        "send-not-landed"
      );
    }
    throw e;
  }
}

/** Where an assistant reply lives. */
const ASSISTANT_SELECTOR = ".qwen-chat-message-assistant";
/** The composer, which carries a real class rather than a hashed one. */
const COMPOSER = "textarea.message-input-textarea";
/** Send. Present but `.disabled` until the composer has something in it. */
const SEND_BUTTON = "button.send-button";
/** Shown in Send's place while an answer is being written. */
const STOP_BUTTON = 'button[aria-label="Stop"]';

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
    pattern: /welcome to qwen|log in to unlock|登录后即可|请先登录/i,
    code: "signed-out",
  },
  // Alibaba's risk control, or an ordinary challenge page. A person clears
  // these; sending again makes it worse.
  {
    pattern: /verify you are human|checking your browser|just a moment|滑动验证|安全验证/i,
    code: "refused",
  },
  { pattern: /rate limit|too many requests|请求过于频繁|访问频繁/i, code: "throttled" },
  { pattern: /server (is )?busy|系统繁忙|服务器繁忙|服务异常/i, code: "service-error" },
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
    .evaluate('(document.body && document.body.innerText) || ""')
    .catch(() => "")) as string;
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
  fs.mkdirSync(dir, { recursive: true });
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

/** The page to work in, on Qwen, created if the context has none. */
export async function chatPage(opts: OpenOptions = {}): Promise<Page> {
  const ctx = await openBrowser(opts);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith(QWEN_CHAT_URL)) {
    await gotoChat(page);
  }
  return page;
}

/** Read the session out of a page's localStorage. */
export async function readStorage(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(
    ([tokenKey, roleKey]) => ({
      [tokenKey]: localStorage.getItem(tokenKey),
      [roleKey]: localStorage.getItem(roleKey),
    }),
    [TOKEN_KEY, ROLE_KEY]
  );
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
  const found = (await page
    .evaluate(
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
    )
    .catch(() => null)) as { name?: string; email?: string } | null;
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
      const storage = await readStorage(page);
      if (!isSignedIn(storage)) {
        if (attempt < tries) {
          await page.waitForTimeout(1_500);
          continue;
        }
        return { signedIn: false };
      }
      const profile = await readProfile(page);
      return { signedIn: true, ...profile };
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
  const nodes = (await page.evaluate(EXTRACT_REPLY_SCRIPT).catch(() => null)) as unknown;
  const count = await page.$$eval(ASSISTANT_SELECTOR, (els) => els.length).catch(() => 0);
  const generating = await page
    .$$eval(STOP_BUTTON, (els) => els.length > 0)
    .catch(() => false);
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
async function stopGenerating(page: Page): Promise<void> {
  try {
    await page.click(STOP_BUTTON, { timeout: 3_000 });
    logger.info("qwen", "stop pressed", { clicked: true });
  } catch (e) {
    // Not necessarily a failure: the button is gone the moment the answer
    // finishes, which is the outcome being asked for.
    logger.info("qwen", "stop not pressed", {
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
  let page = await chatPage(opts);
  if (pendingNewChat) {
    pendingNewChat = false;
    await gotoChat(page);
    await page.waitForTimeout(2_000);
  }
  const before = await readLast(page);

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
  const accepted = (await page.evaluate(fill)) as number;
  if (accepted < 0) {
    throw new QwenError("Qwen's composer was not on the page.", "composer-refused");
  }
  if (accepted < text.length) {
    logger.warn("qwen", "the composer truncated the turn", { sent: text.length, accepted });
  }
  await page.waitForTimeout(300);
  // Three ways to send, in descending order of faithfulness, and every
  // fall-through is logged with its reason.
  //
  // The reason matters and was missing: the first live run fell back on
  // every turn and the log said only "not clickable", which is a symptom
  // with no cause attached. A fallback that works is how a broken primary
  // path stays invisible, so the line that records it has to carry enough
  // to act on.
  try {
    await page.click(SEND_BUTTON, { timeout: 8_000 });
  } catch (e) {
    const why =
      e instanceof Error
        ? e.message.split(String.fromCharCode(10))[0].slice(0, 160)
        : String(e).slice(0, 160);
    // A real click dispatched inside the page. Qwen's menus ignore these -
    // they listen for pointer events - but the send control is an ordinary
    // button and answers to it, measured on the live page.
    const clicked = (await page
      .evaluate(
        `(() => { const b = document.querySelector(${JSON.stringify(SEND_BUTTON)}); if (!b) return "absent"; if (b.disabled || b.className.includes("disabled")) return "disabled"; b.click(); return "clicked"; })()`
      )
      .catch(() => "threw")) as string;
    logger.warn("qwen", "the send button was not clickable", { why, then: clicked });
    if (clicked !== "clicked") await page.keyboard.press("Enter");
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let last: string | null = null;
  let quiet = 0;
  let recovered = false;
  let lastChange = Date.now();
  let lastServiceCheck = Date.now();
  let sawGenerating = false;
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
      if (now.generating) sawGenerating = true;
      const fresh = now.count > before.count || now.text !== before.text;
      if (!fresh || !now.text) {
        // Before waiting the window out: is the page already saying why
        // nothing is coming? The login wall is the common one, and it is
        // readable in a second rather than in ninety.
        if (!last && Date.now() - lastServiceCheck > SERVICE_CHECK_MS) {
          lastServiceCheck = Date.now();
          const said = await serviceMessage(page);
          if (said) {
            throw new QwenError(
              said.code === "signed-out"
                ? "The browser profile is signed out of Qwen, so the message went nowhere. Sign in from the account menu, then send again."
                : `Qwen says: ${said.text}`,
              said.code
            );
          }
        }
        if (Date.now() - lastChange > SILENCE_MS) {
          const storage = await readStorage(page).catch(() => ({}));
          if (!isSignedIn(storage)) {
            throw new QwenError(
              "The browser profile is signed out of Qwen, so the message went nowhere. Sign in from the account menu, then send again.",
              "signed-out"
            );
          }
          throw new QwenError(
            `Qwen did not start answering within ${SILENCE_MS / 1_000}s. The session is still valid, so the send did not land.`,
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
      matches[rule.key] = await page.$$eval(rule.selector, (els) => els.length).catch(() => 0);
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
    const current = await page
      .$eval(trigger, (el) => (el as { innerText?: string }).innerText ?? "")
      .catch(() => "");
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
