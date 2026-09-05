import { loadConfig, saveConfig } from "../config";
import { logger } from "../log";

/**
 * Knowing when to stop.
 *
 * ChatGPT answers overload and abuse checks with an HTTP error, and the worst
 * possible response is another request. An earlier version retried a 403
 * twice, two and four seconds apart, which is exactly the shape an anti-abuse
 * system is watching for — so a soft, self-clearing block turns into a longer
 * one.
 *
 * The rule here is: a failure that will not clear by trying again never gets
 * tried again, and a failure that says "you are going too fast" starts a
 * cooldown that outlives the process. Restarting the CLI and immediately
 * sending again is the most natural thing for a person to do, and the one
 * thing that most reliably deepens a block.
 */

export type FailureKind =
  /** Transient. Worth one more go. */
  | "retry"
  /** Will not clear by retrying, but is not a rate limit either. */
  | "fatal"
  /** The account or device is being throttled. Stop, and wait. */
  | "cooldown";

/**
 * What went wrong, said in a word the code can match on.
 *
 * Until this existed the only thing a failure carried was its English
 * sentence, and `classifyFailure` read that sentence — so the message was
 * simultaneously the text shown to the user and the key that decided whether
 * to retry. Three separate regressions came out of that: a composer stumble
 * whose advice ended "run `onflip login`" was classified fatal by the word
 * "login"; a send failure whose advice said "rate-limited" became a persisted
 * five-minute cooldown; and the real 403 was missed because the wording it
 * arrives with is nothing like the wording that was being matched. Each was
 * fixed by adding another regex above the one that misfired, which is the
 * shape of a taxonomy that cannot be got right.
 *
 * A code is set at the throw site, where what happened is actually known.
 * The regex ladder stays as the fallback for the many `new Error(string)`
 * throws that carry no code, so nothing has to be converted at once — but a
 * coded failure never consults it, and its message is then free to say
 * whatever is most useful to the person reading it.
 */
export type FailureCode =
  /** The abuse check fired. Never retry. */
  | "unusual-activity"
  /** An explicit rate limit: HTTP 429, or the page's own throttle notice. */
  | "throttled"
  /** HTTP 403 with no more specific reading. */
  | "refused"
  /** The message went in but neither send button nor Enter would send it. */
  | "composer-refused"
  /** The message could not be typed into the composer at all. */
  | "composer-entry"
  /** Submitted, but the user's turn never appeared on the page. */
  | "send-not-landed"
  /** The page is anonymous and the stored session has not fixed it yet. */
  | "anonymous"
  /** The page lost the live thread; the transcript needs replaying. */
  | "chat-lost"
  /** No usable session at all. Only a sign-in fixes this. */
  | "signed-out"
  /** ChatGPT's own error page came back instead of a reply. */
  | "service-error"
  /** The user stopped it. */
  | "interrupted";

/** Default quiet period when the server does not name one. */
const DEFAULT_COOLDOWN_SECONDS = 15 * 60;

/** How each code is treated, when one is present. */
const BY_CODE: Record<FailureCode, { kind: FailureKind; seconds: number }> = {
  "unusual-activity": { kind: "cooldown", seconds: DEFAULT_COOLDOWN_SECONDS },
  throttled: { kind: "cooldown", seconds: 5 * 60 },
  refused: { kind: "cooldown", seconds: DEFAULT_COOLDOWN_SECONDS },
  "composer-refused": { kind: "retry", seconds: 0 },
  "composer-entry": { kind: "retry", seconds: 0 },
  "send-not-landed": { kind: "retry", seconds: 0 },
  anonymous: { kind: "retry", seconds: 0 },
  "chat-lost": { kind: "retry", seconds: 0 },
  "signed-out": { kind: "fatal", seconds: 0 },
  "service-error": { kind: "retry", seconds: 0 },
  interrupted: { kind: "fatal", seconds: 0 },
};

function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && Object.hasOwn(BY_CODE, value);
}

/**
 * The code an error carries, if it carries one.
 *
 * Read by duck typing rather than by importing the error class: this module
 * is imported by the transport that defines that class, and the classifier
 * has no business depending on the thing it classifies.
 */
export function failureCodeOf(e: unknown): FailureCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return isFailureCode(code) ? code : undefined;
}

interface Classification {
  kind: FailureKind;
  /** How long to stay quiet, in seconds, for a cooldown. */
  seconds: number;
  /** What to tell the user. */
  reason: string;
}

export function classifyFailure(message: string, code?: FailureCode): Classification {
  const m = message || "";

  // A failure that knows what it is does not get guessed at. The message is
  // still what the user reads; it just no longer decides anything.
  if (code) {
    const { kind, seconds } = BY_CODE[code];
    // A throttle may name its own delay, and honouring it beats a default.
    if (code === "throttled") {
      const after = /retry[- ]after[":\s]+(\d+)/i.exec(m);
      if (after) return { kind, seconds: Math.min(3600, Number(after[1])), reason: m };
    }
    return { kind, seconds, reason: m };
  }

  // The abuse check. This is the one that arrives when requests do not look
  // like they came from a browser, and it is emphatically not retryable.
  if (/unusual activity/i.test(m)) {
    return {
      kind: "cooldown",
      seconds: DEFAULT_COOLDOWN_SECONDS,
      reason:
        "ChatGPT flagged the request as unusual activity. That check fires on requests that do not look like they came from a browser, and retrying makes it worse.",
    };
  }

  // The transport's own send-path failures, tested before the throttle
  // patterns because their advice text used to say "rate-limited" — and this
  // function read the advice. Same disease as the composer-entry case below,
  // second outbreak: a composer that would not clear became a persisted
  // five-minute cooldown, three times in one evening, when what it usually
  // means is the page was not ready and one retry fixes it. A genuine
  // throttle still cools down through the signals ChatGPT itself sends — an
  // HTTP 429 in an error, or a "you've reached your limit" reply.
  // "anonymous mode … could not be restored" is in this list for the fatal
  // patterns' sake rather than the throttle's: its advice ends "refresh the
  // session with the CLI, and the word "login" is what the fatal
  // test matches on. The failure itself healed on retry both times it was
  // seen — the recovery reload runs again on each attempt.
  if (
    /would not accept it|typed but never sent|never showed it working|anonymous mode and the session could not be restored/i.test(
      m
    )
  ) {
    return { kind: "retry", seconds: 0, reason: m };
  }

  if (/HTTP 429|too many requests|rate.?limit/i.test(m)) {
    // Honour a server-supplied delay when there is one.
    const after = /retry[- ]after[":\s]+(\d+)/i.exec(m);
    const seconds = after ? Math.min(3600, Number(after[1])) : 5 * 60;
    return {
      kind: "cooldown",
      seconds,
      reason: "ChatGPT is rate-limiting this account.",
    };
  }

  if (/HTTP 403/.test(m)) {
    return {
      kind: "cooldown",
      seconds: DEFAULT_COOLDOWN_SECONDS,
      reason: "ChatGPT refused the request (403).",
    };
  }

  // The composer refusing the message is the page not being ready yet — the
  // exact failure a short retry fixes, measured on every cold start of this
  // machine. It must be tested before the fatal patterns below: its advice
  // text once ended "run `onflip login --headed`", and that word "login" made the
  // fatal test swallow it, so the one error that most wants a retry was the
  // one error that never got it. The user's manual resend always worked,
  // which is precisely what the retry should have been.
  if (/could not be entered into the ChatGPT composer/i.test(m)) {
    return { kind: "retry", seconds: 0, reason: m };
  }

  if (/log ?in|signed out|Cloudflare|Interrupted/i.test(m)) {
    return { kind: "fatal", seconds: 0, reason: m };
  }

  return { kind: "retry", seconds: 0, reason: m };
}

/**
 * Would one more turn get this session moving again?
 *
 * A long run ends in a red error often enough to be worth a button: the
 * conversation the turn was using stops answering — signed out, not found,
 * a composer that will not take another message — and the turn dies with
 * the transcript perfectly intact. Typing "continue" fixes it, every time,
 * because the next turn opens a fresh conversation and re-sends the
 * transcript into it. The chat was lost; the work never was.
 *
 * So the question is not which failures look recoverable but which ones
 * are made worse by trying. Two: a cooldown, where another request is the
 * one thing that deepens the block, and a stop the user asked for, where
 * resuming would undo their decision. Everything else is worth the turn.
 */
export function isResumableFailure(message: string, code?: FailureCode): boolean {
  const m = message || "";
  if (code === "interrupted") return false;
  // A session that is simply gone is not resumed by sending again: every
  // attempt opens another chat against an account that will refuse it, which
  // is the loop this used to produce — 41 identical re-injections over
  // seventeen minutes on one measured session. Signing in is the only fix,
  // and saying so beats trying.
  if (code === "signed-out") return false;
  if (!code && /\bInterrupted\b|\baborted\b/i.test(m)) return false;
  if (/Waiting out a ChatGPT cooldown/i.test(m)) return false;
  return classifyFailure(m, code).kind !== "cooldown";
}
/**
 * Is this ChatGPT talking, rather than the model answering?
 *
 * Image moderation, rate limits and error pages all come back through the same
 * channel as a reply, and they are not replies. This lives here rather than in
 * the agent loop because the transport has to know first: a thread that
 * answered "Something went wrong" never received what was sent, and marking
 * that payload as delivered is what turns a transient error into a session
 * that has permanently lost its system prompt.
 *
 * Gated on a short reply, because a long answer quoting one of these phrases
 * is discussing it, not being it.
 */
export function serviceMessage(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t || t.length > 400) return null;

  // Not moderation but the same channel: ChatGPT declining a capability of
  // its own, which reads as the agent giving up on the task it was asked to
  // do. Seen in the field as "image creation is temporarily unavailable"
  // mid-way through building a page that wanted a banner.
  if (/image (creation|generation) is (currently |temporarily )?unavailable/i.test(t)) {
    return "That was ChatGPT declining to generate an image, not OnFlip refusing the task. OnFlip has no image tool — ask for SVG or CSS instead and the agent can write it directly into your files.";
  }
  if (/image we created may violate|content polic/i.test(t)) {
    return "That message came from ChatGPT's image moderation, not from OnFlip — the picture was generated and then blocked. Rewording the prompt usually clears it; brand and game names are a common trigger. OnFlip has no image tool, so a generated image stays in the web chat rather than being saved to your project.";
  }
  if (/you'?ve (reached|hit) (your|the) .{0,30}(limit|cap)|rate limit|usage limit/i.test(t)) {
    return "ChatGPT is rate-limiting this account, so that was its message rather than an answer. Waiting, or switching model with /model, is what clears it.";
  }
  if (/^(something went wrong|an error occurred|there was an error)\b/i.test(t)) {
    return "ChatGPT returned an error page instead of a reply, so nothing of what OnFlip sent reached the model. This is usually an oversized message — /compact shrinks the conversation, and /new starts a fresh one.";
  }
  // The backend's own failure pages, arriving as a one-line "reply". Live:
  // "Internal Server Error", 21 characters, accepted as the model's answer
  // to a protocol correction — so the correction was marked delivered, the
  // turn ended on the error text, and nothing was built. A short reply that
  // *is* an HTTP status phrase is never an answer. Worded without any of
  // the words `classifyFailure` treats as fatal or as a throttle, because
  // it reads this text: the one thing to do about a 5xx is send again.
  if (
    t.length <= 160 &&
    /^(?:\d{3}\s+)?(internal server error|bad gateway|service unavailable|gateway time-?out|request time-?out|server error)\b/i.test(
      t
    )
  ) {
    return `ChatGPT's server answered with "${t.slice(0, 40)}" instead of a reply, so the message never reached the model. Sending it again.`;
  }
  if (
    /^(hmm+[.…]* ?something seems to have gone wrong|oops[,!.]? (an error|something)|error in message stream|network error|conversation not found)\b/i.test(
      t
    )
  ) {
    return `ChatGPT's page reported "${t.slice(0, 60)}" instead of a reply, so the message never reached the model. Sending it again.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the cooldown itself
// ---------------------------------------------------------------------------

/** Persisted, so a restart cannot walk straight back into the block. */
export function startCooldown(seconds: number, reason: string): void {
  const until = Date.now() + seconds * 1_000;
  const existing = loadConfig().cooldownUntil ?? 0;
  // Never shorten one that is already running.
  if (until <= existing) return;
  saveConfig({ cooldownUntil: until });
  logger.warn("transport", "cooldown started", { seconds, until, reason });
}

export function cooldownRemainingMs(): number {
  const until = loadConfig().cooldownUntil ?? 0;
  return Math.max(0, until - Date.now());
}

export function clearCooldown(): void {
  if (loadConfig().cooldownUntil) saveConfig({ cooldownUntil: undefined });
}

export function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

// ---------------------------------------------------------------------------
// pacing
// ---------------------------------------------------------------------------

/**
 * Smallest gap between two outgoing messages.
 *
 * A tool loop can finish its work in milliseconds and come straight back for
 * the next turn; a person cannot. The floor costs nothing on a turn that took
 * ten seconds to answer and takes the spikiness out of the ones that did not.
 */
const MIN_SEND_GAP_MS = 1_500;
let lastSendAt = 0;

/**
 * Sleep, unless the turn is being stopped.
 *
 * The `abort` listener alone is not enough, and a test caught why: a signal
 * that is *already* aborted will never fire the event, because the event has
 * been and gone. Every pacing wait therefore ran to completion on an
 * interrupted turn — 1.5 seconds for a send, and up to thirty for a paced
 * conversation, spent sleeping on work the user had just cancelled. Checking
 * the flag before arming the listener is the whole fix.
 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export async function paceSend(signal?: AbortSignal): Promise<void> {
  const since = Date.now() - lastSendAt;
  const wait = MIN_SEND_GAP_MS - since;
  if (lastSendAt && wait > 0) await sleepUnlessAborted(wait, signal);
  lastSendAt = Date.now();
}

/**
 * Smallest gap between two *new conversations*, which is a different limit.
 *
 * Opening a chat is the expensive request as far as ChatGPT's abuse controls
 * are concerned, and OnFlip opens one far more eagerly than a person would:
 * ten separate places drop the live thread (a refused composer reloads and
 * starts again, a stalled generation starts again, a 401 re-injects and
 * starts again, compaction starts again, an auto-resume starts again), and
 * each of those then opens a chat on the next send. Measured in one session:
 * 32 new chats for 55 replies, and the account was told it was sending too
 * quickly. The message floor above does not help, because the burst is not
 * messages — it is the recovery paths racing each other.
 *
 * So the gap here is wider, and it grows with how many chats have been opened
 * in the last hour. Ten in an hour is already well past anything a person
 * does, and by then a fresh chat waits fifteen seconds — long enough to break
 * a recovery loop, short enough that a real session barely notices.
 */
const MIN_NEW_CHAT_GAP_MS = 3_000;
const NEW_CHAT_WINDOW_MS = 60 * 60_000;
/** Above this many chats in the window, the gap starts climbing. */
const NEW_CHAT_SOFT_LIMIT = 10;
const MAX_NEW_CHAT_GAP_MS = 30_000;

let newChatTimes: number[] = [];

/** How many conversations have been opened in the trailing hour. */
export function newChatsInWindow(now = Date.now()): number {
  newChatTimes = newChatTimes.filter((t) => now - t < NEW_CHAT_WINDOW_MS);
  return newChatTimes.length;
}

/** The gap a new chat should wait for, given how many came before it. */
export function newChatGapMs(now = Date.now()): number {
  const recent = newChatsInWindow(now);
  if (recent <= NEW_CHAT_SOFT_LIMIT) return MIN_NEW_CHAT_GAP_MS;
  const over = recent - NEW_CHAT_SOFT_LIMIT;
  return Math.min(MAX_NEW_CHAT_GAP_MS, MIN_NEW_CHAT_GAP_MS * (1 + over));
}

/**
 * Wait, if need be, before opening a conversation — and record that one was.
 *
 * Deliberately not a throw: a chat that has to be opened has to be opened,
 * and refusing would turn a slow recovery into a failed one. Slowing the
 * burst is the whole point.
 */
export async function paceNewChat(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const last = newChatTimes.length ? newChatTimes[newChatTimes.length - 1] : 0;
  const wait = last ? newChatGapMs(now) - (now - last) : 0;
  if (wait > 0) {
    logger.info("transport", "pacing a new conversation", {
      waitMs: wait,
      openedInLastHour: newChatsInWindow(now),
    });
    await sleepUnlessAborted(wait, signal);
  }
  newChatTimes.push(Date.now());
}

/** For tests, which must not inherit another test's burst history. */
export function __resetPacingForTest(): void {
  newChatTimes = [];
  lastSendAt = 0;
}

/** Throw rather than send while a cooldown is running. */
export function assertNotCoolingDown(): void {
  const remaining = cooldownRemainingMs();
  if (remaining <= 0) return;
  throw new Error(
    `Waiting out a ChatGPT cooldown — ${describeWait(remaining)} left. Sending now would extend it.`
  );
}
