/**
 * The watch that notices a turn has stopped.
 *
 * Its own file, and its own clock, because the bug it exists to catch is a
 * timing bug and timing bugs are exactly what an engine test cannot reach. The
 * engine owns a browser, a transport, a peer and a config file; none of that
 * is needed to answer the questions that actually go wrong here — does the
 * warning fire once or every tick, does an approval prompt count as silence,
 * does stopping the watch stop it, does a turn that crosses both thresholds
 * between two ticks restart or merely get warned about.
 *
 * So the clock and the callbacks are injected, the class holds no state the
 * caller cannot see, and a test drives a whole seven-minute stall in a
 * millisecond.
 */

export type SilenceVerdict = "quiet" | "warn" | "restart" | "exhausted";

export interface SilenceOptions {
  /** Quiet for this long and the user is told. */
  warnAfterMs: number;
  /** Quiet for this long and the work is carried into a fresh conversation. */
  restartAfterMs: number;
  /** Injected so a test can run a stall without waiting for one. */
  now?: () => number;
  /** False while automatic resume is switched off: warn, never restart. */
  canRestart: () => boolean;
  /** False once the run has used its allowance of restarts. */
  hasRestartsLeft: () => boolean;
  /** True while the turn is legitimately waiting — an approval prompt is up. */
  isPaused?: () => boolean;
  /** True while there is a turn to watch at all. */
  isRunning: () => boolean;
  onWarn: (idleMs: number) => void;
  onRestart: (idleMs: number) => void;
  onExhausted: (idleMs: number) => void;
}

/**
 * Decide what a given silence deserves.
 *
 * Exported on its own because the order is the part worth pinning down: the
 * restart is considered before the warning, so a turn that crosses both lines
 * between two ticks restarts rather than only getting warned about.
 */
export function silenceVerdict(
  idleMs: number,
  opts: {
    warnAfterMs: number;
    restartAfterMs: number;
    canRestart: boolean;
    restartsLeft: boolean;
    warned: boolean;
  }
): SilenceVerdict {
  if (idleMs >= opts.restartAfterMs && opts.canRestart) {
    return opts.restartsLeft ? "restart" : "exhausted";
  }
  // With automatic resume switched off the warning is the whole service, so
  // it still fires — and goes on being the only thing that will.
  if (idleMs >= opts.warnAfterMs && !opts.warned) return "warn";
  return "quiet";
}

export class SilenceWatch {
  private timer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private warned = false;
  /**
   * This watch has already had its last word about the current turn.
   *
   * Separate from the timer, and not the same question. Clearing the interval
   * stops future ticks but not one already queued behind it, and a tick that
   * lands after a restart has been ordered would order a second one — burning
   * the run's whole allowance on a single stall. Found by the harness, which
   * drives ticks by hand and so reaches the state a timer only reaches by
   * unlucky timing.
   */
  private finished = false;
  private readonly now: () => number;

  constructor(private readonly opts: SilenceOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Begin watching, treating this moment as the last thing that happened. */
  start(intervalMs = 20_000): void {
    this.stop();
    this.finished = false;
    this.mark();
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Nothing here should hold the process open on its own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.warned = false;
  }

  get watching(): boolean {
    return this.timer !== null;
  }

  /** Something happened. Whatever it was, the turn is not wedged. */
  mark(): void {
    this.lastActivityAt = this.now();
    this.warned = false;
  }

  /** How long the turn has been silent, for a message that says so. */
  idleMs(): number {
    return this.now() - this.lastActivityAt;
  }

  /**
   * One pass. Public so a test can drive it directly rather than waiting for
   * the interval, and harmless to call when there is nothing to watch.
   */
  tick(): SilenceVerdict {
    if (this.finished) return "quiet";
    if (!this.opts.isRunning()) return "quiet";
    // Waiting on a person is not being stuck, however long they take.
    if (this.opts.isPaused?.()) {
      this.mark();
      return "quiet";
    }

    const idle = this.idleMs();
    const verdict = silenceVerdict(idle, {
      warnAfterMs: this.opts.warnAfterMs,
      restartAfterMs: this.opts.restartAfterMs,
      canRestart: this.opts.canRestart(),
      restartsLeft: this.opts.hasRestartsLeft(),
      warned: this.warned,
    });

    // Both endings stop the watch: there is nothing further it can usefully
    // do, and repeating either every twenty seconds at somebody who is not at
    // the desk is worse than silence.
    if (verdict === "restart") {
      this.finished = true;
      this.stop();
      this.opts.onRestart(idle);
      return "restart";
    }
    if (verdict === "exhausted") {
      this.finished = true;
      this.stop();
      this.opts.onExhausted(idle);
      return "exhausted";
    }
    if (verdict === "warn") {
      this.warned = true;
      this.opts.onWarn(idle);
      return "warn";
    }
    return verdict;
  }
}
