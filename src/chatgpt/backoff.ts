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

interface Classification {
  kind: FailureKind;
  /** How long to stay quiet, in seconds, for a cooldown. */
  seconds: number;
  /** What to tell the user. */
  reason: string;
}

/** Default quiet period when the server does not name one. */
const DEFAULT_COOLDOWN_SECONDS = 15 * 60;

export function classifyFailure(message: string): Classification {
  const m = message || "";

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

  if (/log ?in|signed out|Cloudflare|Interrupted/i.test(m)) {
    return { kind: "fatal", seconds: 0, reason: m };
  }

  return { kind: "retry", seconds: 0, reason: m };
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

export async function paceSend(signal?: AbortSignal): Promise<void> {
  const since = Date.now() - lastSendAt;
  const wait = MIN_SEND_GAP_MS - since;
  if (lastSendAt && wait > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
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
  lastSendAt = Date.now();
}

/** Throw rather than send while a cooldown is running. */
export function assertNotCoolingDown(): void {
  const remaining = cooldownRemainingMs();
  if (remaining <= 0) return;
  throw new Error(
    `Waiting out a ChatGPT cooldown — ${describeWait(remaining)} left. Sending now would extend it. Run \`onflip status\` to see when it lifts.`
  );
}
