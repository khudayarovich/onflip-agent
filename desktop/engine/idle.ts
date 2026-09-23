/**
 * An app left open goes quiet, then gets out of the way.
 *
 * The session watch asked DeepSeek or Qwen whether the session was still
 * alive every three minutes for as long as the window stayed open — all
 * night, if that is how long it stayed open. Two things were wrong with
 * that. A request every three minutes at four in the morning is not
 * something a person does, and looking like a person is the whole reason
 * the interval is as long as it is. And the headless browser that answers
 * those checks sat running the service's page — its timers, its sockets,
 * a few hundred megabytes — for somebody who had gone home.
 *
 * So idleness has three stages, all decided here, purely, and tested:
 *
 *   In use: the watch checks as before, because a session that ends while
 *   somebody is working should be said before they send into it.
 *
 *   Quiet (IDLE_QUIET_MS without anything asked of the app): no requests.
 *   Nobody is there to read a banner; it would only be noise to the service.
 *
 *   Parked (IDLE_PARK_MS): the browser is closed. What that costs is known
 *   and paid once — the next message opens the browser again and the live
 *   thread is gone with it, so the transcript is sent in full into a new
 *   one, exactly as after Stop. Two hours rather than one so a lunch break
 *   keeps the thread and a night does not keep the browser.
 *
 * Coming back undoes it. The window's focus reaches the engine as `wake`,
 * and a wake after a quiet spell looks at the session straight away — so
 * the banner is true before anything is typed, and a parked browser is
 * already reopening while the person reads.
 */

/**
 * How often the session is re-checked while the app is in use.
 *
 * Short enough that a session ending is noticed before the next message is
 * written; long enough that a service watching for automation sees a request
 * a person could plausibly have caused. Sessions were measured lasting
 * hours, so this is about catching the change, not racing it.
 */
export const SESSION_WATCH_MS = 3 * 60_000;

/** Nothing asked of the app for this long, and the watch stops asking the service. */
export const IDLE_QUIET_MS = 20 * 60_000;

/** Nothing asked of the app for this long, and the service's browser is closed. */
export const IDLE_PARK_MS = 2 * 60 * 60_000;

export type IdleStep = "check" | "skip" | "park";

export interface IdleState {
  /** A turn is running: it will find out about the session for itself. */
  busy: boolean;
  /** The session was found signed in, so there is a session to watch. */
  watching: boolean;
  /** The browser has been closed for idleness and not reopened since. */
  parked: boolean;
}

/** What one tick of the watch does, given how long the app has gone unused. */
export function idleStep(idleMs: number, state: IdleState): IdleStep {
  if (state.busy) return "skip";
  if (idleMs >= IDLE_PARK_MS) return state.parked ? "skip" : "park";
  if (idleMs >= IDLE_QUIET_MS) return "skip";
  return state.watching ? "check" : "skip";
}

/**
 * Whether coming back to the window should look at the session now.
 *
 * Only when the watch has something to say that it has not said recently:
 * a focus event arrives on every switch between windows, and each one
 * asking the service would be the pattern the quiet stage exists to avoid.
 */
export function lookOnWake(sinceCheckMs: number, state: IdleState): boolean {
  if (state.busy || !state.watching) return false;
  return state.parked || sinceCheckMs >= SESSION_WATCH_MS;
}
