import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { checkSignedIn, closeBrowser } from "./browser";
import { ARENA_CHAT_URL, arenaProfileDir, ARENA_LAUNCH_ARGS } from "./session";
import { mkdirPrivate } from "../../config";

/**
 * Signing in to Arena, in a browser Google accepts.
 *
 * The same flow the other browser providers use, for the same reason: an
 * ordinary Chrome, started the way a person starts one, on the profile
 * OnFlip will later drive. Arena offers "Continue with Google" and
 * "Continue with email", and Google refuses OAuth from a browser it can tell
 * is embedded or driven — so the sign-in happens with no driver attached and
 * the profile is opened afterwards.
 *
 * This is the simplest of the three sign-ins, and the reason is worth
 * stating. Qwen's had to scan a LevelDB for token fingerprints because its
 * session is a string in localStorage that a lapsed profile also has, at
 * full length and correct shape — so "is there a token" could not tell a
 * sign-in from a stale one. Arena's session is a cookie, and the cookie a
 * visitor gets *disappears* when an account arrives. Asking the jar is both
 * cheaper and more honest, and it is what `checkSignedIn` already does.
 */

let child: ChildProcess | null = null;
let cancelled = false;
/** Resolved when the user says they are done, whatever the window is doing. */
let declareFinished: (() => void) | null = null;

/** Long enough for a Google sign-in and a two-step prompt; not forever. */
const DEADLINE_MS = 15 * 60_000;

/**
 * Below this, the process exiting is Chrome handing off, not a user finishing.
 *
 * On Windows the `chrome.exe` that is started does not always become the
 * browser: with a `--user-data-dir` of its own it can spawn the real browser
 * and exit at once, leaving its window on screen.
 */
const HANDOFF_MS = 8_000;

export type SignInProgress = "waiting" | "verifying";

export interface ArenaSignInResult {
  ok: boolean;
  /** Why it did not succeed: "cancelled" | "timeout" | an error message. */
  reason?: string;
}

export function signInRunning(): boolean {
  return child !== null || declareFinished !== null;
}

/** The user says they are done; stop waiting and check the profile. */
export function finishSignIn(): void {
  declareFinished?.();
}

export function cancelSignIn(): void {
  cancelled = true;
  declareFinished?.();
}

/**
 * Close the window the way the browser's own Quit does, and wait for it.
 *
 * Two failures live in the difference, both learned on the other providers:
 * a hard kill can lose the last writes, and returning before the exit lets
 * the verification open a profile the exiting Chrome still holds — which
 * reads as "no session" to somebody who has just signed in.
 */
async function closeWindowGracefully(): Promise<void> {
  const running = child;
  if (!running) return;
  if (running.exitCode !== null || running.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => {
    running.once("exit", () => resolve());
  });
  try {
    if (process.platform === "win32" && running.pid) {
      // Without /F this is a WM_CLOSE: windows close, the profile is written
      // out, the process ends.
      spawn("taskkill", ["/PID", String(running.pid)], { windowsHide: true, stdio: "ignore" });
    } else {
      running.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
  const closed = await Promise.race([
    gone.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
  ]);
  if (!closed) {
    try {
      running.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3_000))]);
  }
}

/**
 * Has an account's cookie reached the profile on disk yet?
 *
 * Read while the browser still holds the file, which is the whole point.
 * On macOS closing a window does not quit the application, so waiting for
 * the process to exit means waiting for somebody to find the button in
 * OnFlip — and clicking Sign in again instead spawns a second browser onto
 * the same profile. Reported exactly that way: a fresh browser every time
 * and no account at the end of it.
 *
 * Chromium stores cookies in a SQLite file whose *values* are encrypted and
 * whose *names* are not, so the name is findable by scanning the bytes. No
 * parsing, no sqlite binding, and nothing decrypted — the question is only
 * whether a cookie by this name exists, and the profile is opened and asked
 * properly afterwards regardless.
 *
 * Copied first because the running browser holds the original open, which is
 * the same move Qwen's sign-in makes on its LevelDB for the same reason.
 *
 * A false negative costs nothing: the flow simply waits, as it did before.
 */
function accountCookieOnDisk(dir: string): boolean {
  const candidates = [
    path.join(dir, "Default", "Network", "Cookies"),
    path.join(dir, "Default", "Cookies"),
  ];
  const needle = Buffer.from("arena-auth-prod-v");
  for (const file of candidates) {
    const tmp = path.join(os.tmpdir(), `onflip-arena-signin-${process.pid}-${Date.now()}`);
    try {
      fs.copyFileSync(file, tmp);
      const found = fs.readFileSync(tmp).includes(needle);
      if (found) return true;
    } catch {
      // Not there, or held in a way that refuses a copy; the next poll asks
      // again and the proper check runs at the end either way.
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return false;
}

export async function signInWithRealBrowser(
  onProgress?: (state: SignInProgress) => void
): Promise<ArenaSignInResult> {
  if (child) return { ok: false, reason: "An Arena sign-in window is already open." };

  const pick = pickSignInBrowser();
  if (!pick) {
    return {
      ok: false,
      reason:
        "No browser to sign in with was found. Install Google Chrome or Microsoft Edge and try again.",
    };
  }
  if (pick.channel === "chromium") {
    logger.warn("arena", "only the bundled browser is available; a Google sign-in may be refused");
  }

  // Nothing else may hold the profile: a second browser on the same
  // directory refuses to start, and the driver may be sitting on it.
  await closeBrowser();

  const dir = arenaProfileDir();
  mkdirPrivate(dir);
  cancelled = false;

  let started: ChildProcess;
  try {
    started = spawn(
      pick.executable,
      [
        `--user-data-dir=${dir}`,
        ...ARENA_LAUNCH_ARGS,
        "--new-window",
        ...(process.platform === "linux" ? ["--password-store=basic"] : []),
        ARENA_CHAT_URL,
      ],
      { stdio: "ignore", windowsHide: false }
    );
  } catch (e) {
    return {
      ok: false,
      reason: `Could not start ${pick.name}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  child = started;
  const startedAt = Date.now();
  // The profile is logged because "the sign-in did not stick" and "a
  // different provider's sign-in ran" look identical from outside, and the
  // difference is one path. Reported that way: a browser opening fresh every
  // time, and no account afterwards.
  logger.info("arena", "sign-in window opened", {
    channel: pick.channel,
    profile: dir,
    executable: pick.executable,
  });
  onProgress?.("waiting");

  const finished = new Promise<"finished">((resolve) => {
    declareFinished = () => resolve("finished");
  });
  const exited = new Promise<"closed">((resolve) => {
    const done = () => {
      const openFor = Date.now() - startedAt;
      child = null;
      if (openFor >= HANDOFF_MS) return resolve("closed");
      logger.info("arena", "the launcher exited immediately; the window is another process", {
        afterMs: openFor,
      });
    };
    started.once("exit", done);
    started.once("error", done);
  });

  const deadline = Date.now() + DEADLINE_MS;
  const outcome = await (async (): Promise<"closed" | "finished" | "timeout"> => {
    const tick = () => new Promise<"tick">((r) => setTimeout(() => r("tick"), 2_000));
    for (;;) {
      const step = await Promise.race([exited, finished, tick()]);
      if (step !== "tick") return step;
      if (Date.now() > deadline) return "timeout";
      // The session reaching the profile is the thing being waited for, so
      // it ends the wait — rather than the window closing, which on macOS
      // is not an event that happens.
      if (accountCookieOnDisk(dir)) {
        logger.info("arena", "the account reached the profile; closing the sign-in window");
        return "finished";
      }
    }
  })();
  declareFinished = null;

  // Nothing may touch the profile until the browser is gone: closing
  // gracefully is what flushes the session to disk.
  await closeWindowGracefully();
  child = null;

  if (outcome === "timeout") {
    return {
      ok: false,
      reason:
        "The sign-in window was open for fifteen minutes without an account. Try again when you are ready.",
    };
  }
  if (cancelled) return { ok: false, reason: "cancelled" };

  onProgress?.("verifying");
  await new Promise((r) => setTimeout(r, 1_500));
  // The jar is the answer, and it is not ambiguous: an account's cookies are
  // there or they are not. No fingerprinting, no scanning, no guessing at
  // whether a session that looks present is a session that works.
  const check = await checkSignedIn({ tries: 3 });
  await closeBrowser();

  if (check.signedIn) {
    logger.info("arena", "signed in", { profile: dir });
    return { ok: true };
  }
  // Said plainly in the log, because the message a person sees cannot
  // distinguish "you did not finish" from "it did not persist" and the two
  // need different things done about them.
  logger.warn("arena", "no account in the profile after the sign-in window closed", {
    profile: dir,
    error: check.error ?? null,
  });
  if (check.error) {
    logger.warn("arena", "the profile could not be read after sign-in", { error: check.error });
    return {
      ok: false,
      reason: `OnFlip could not open the Arena profile to check the session (${check.error.split(String.fromCharCode(10))[0].slice(0, 140)}). Quit any browser still using it and try again.`,
    };
  }
  return {
    ok: false,
    reason:
      "The window closed without an Arena account. Arena also works signed out, but an account is what gives you history and a larger allowance — open the sign-in again and use the button in OnFlip to finish.",
  };
}
