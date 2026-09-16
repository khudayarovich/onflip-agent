import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { checkSignedIn, closeBrowser } from "./browser";
import { ARENA_CHAT_URL, arenaProfileDir, ARENA_SIGN_IN_ARGS } from "./session";
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
 * This was written believing it would be the simplest of the three sign-ins.
 * Qwen's has to fingerprint a LevelDB because its session is a string that a
 * lapsed profile also holds, at full length and correct shape; Arena's is a
 * cookie, and a cookie is either in the jar or it is not. So this asked the
 * jar — and it shipped, and it closed the window while Google was still
 * asking for a password.
 *
 * A cookie is not simpler. The account cookie's NAME is written on the way
 * INTO a sign-in, and the file keeps the bytes of records it has deleted, so
 * "is it there" answers yes before anybody has signed in, and yes again on a
 * profile where an attempt once failed. The honest question turns out to be
 * Qwen's question — has a session APPEARED, and has it stopped changing —
 * and the cost of learning that a second time is `authCookiePrints` below.
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
 * A finished session, told apart from a sign-in still in progress.
 *
 * Every cookie Arena's auth uses starts `arena-auth-prod-v`, which is why
 * matching the prefix was not enough — and why this file shipped a window
 * that closed itself while Google was still asking for a password. Watched
 * on a live sign-in, in order:
 *
 *   Log In pressed              arena-auth-prod-v1
 *   Continue with Google        arena-auth-prod-v1-code-verifier
 *   ...then nothing at all, for as long as the person takes to type...
 *   the session lands           arena-auth-prod-v1.0, arena-auth-prod-v1.1
 *
 * The first two are a sign-in beginning, and they sit perfectly still while
 * somebody is at Google's password box — so any rule about a cookie merely
 * appearing and holding still fires with the person mid-sign-in.
 *
 * The chunk suffix is the real signal. Supabase splits a cookie it cannot
 * fit in one, and only a genuine session JWT is that big; the pending marker
 * and the verifier never are. So `.0`/`.1` means an account arrived, and
 * that is what this matches.
 */
const SESSION_COOKIE = /^arena-auth-prod-v\d+\.\d+/;

/**
 * Where a finished session sits in a cookie file, and under what name.
 *
 * Chrome leaves no delimiter after a cookie's name — the encrypted value
 * follows immediately, with its own `v10` marker — so this reads a short
 * window and anchors the match at the start rather than trying to work out
 * where the name ends.
 */
function scanSessions(buf: Buffer): { at: number; name: string }[] {
  const found: { at: number; name: string }[] = [];
  const needle = Buffer.from("arena-auth-prod-v");
  let at = -1;
  while ((at = buf.indexOf(needle, at + 1)) !== -1) {
    const m = SESSION_COOKIE.exec(buf.subarray(at, at + 32).toString("latin1"));
    if (m) found.push({ at, name: m[0] });
  }
  return found;
}

/**
 * The session cookies in a stretch of file, by name.
 *
 * Exported for the tests, which hold the rule against the byte shapes a real
 * profile produces — the in-flight cookies included, since telling those
 * apart is the whole job.
 */
export function authCookieNames(buf: Buffer): string[] {
  return scanSessions(buf).map((s) => s.name);
}

/**
 * Every finished-session record the profile holds on disk, as fingerprints.
 *
 * Fingerprints and not values: nothing here needs the cookie, and a
 * credential held in a variable for no reason is one that gets logged by
 * accident — they are encrypted at rest in any case.
 *
 * A set rather than one value, because a SQLite file keeps the bytes of rows
 * it has deleted. A profile that has been through one failed attempt still
 * carries the old names, so the question can never be "is one there" — only
 * "has one appeared", which needs the set from before the window opened.
 */
export function authCookiePrints(dir: string): Set<string> {
  const out = new Set<string>();
  const needle = Buffer.from("arena-auth-prod-v");
  for (const file of [
    path.join(dir, "Default", "Network", "Cookies"),
    path.join(dir, "Default", "Cookies"),
  ]) {
    const tmp = path.join(os.tmpdir(), `onflip-arena-signin-${process.pid}-${Date.now()}`);
    let buf: Buffer;
    try {
      fs.copyFileSync(file, tmp);
      buf = fs.readFileSync(tmp);
    } catch {
      continue; // not there, or held in a way that refuses a copy
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    for (const { at } of scanSessions(buf)) {
      // Enough of what follows to tell two sessions apart.
      out.add(
        createHash("sha256").update(buf.subarray(at, at + 220)).digest("hex").slice(0, 16)
      );
    }
  }
  return out;
}

/** A session this profile did not have before the window opened. */
export function hasNewAccount(before: Set<string>, now: Set<string>): boolean {
  for (const print of now) if (!before.has(print)) return true;
  return false;
}

/**
 * How long a new record must stand before the window is closed on it.
 *
 * A chunked session is not one write. `arena-auth-prod-v1.0` and `v1.1` are
 * two halves of one JWT, landing one after the other, and a window closed
 * between them takes half a session with it — which would read afterwards as
 * "signed in" to the cookie check and fail on the first turn.
 *
 * Five seconds is far longer than the gap between two chunk writes and far
 * shorter than anybody's patience. It is deliberately not the number that
 * guards against closing mid-sign-in: no amount of waiting does that, since
 * a person at a password box can take minutes, and `SESSION_COOKIE` is what
 * keeps the in-flight cookies from starting this clock at all.
 */
const SETTLE_MS = 5_000;

/**
 * Is this new session finished being written?
 *
 * Pure so the rule can be held against a sequence of readings without a
 * browser: something new has appeared, it has stopped changing, and enough
 * time has passed for the round trip to have completed.
 */
export function newAccountSettled(
  firstSeenAt: number,
  lastPrints: Set<string>,
  nowPrints: Set<string>,
  now: number,
  settleMs: number = SETTLE_MS
): boolean {
  if (!firstSeenAt) return false;
  if (now - firstSeenAt < settleMs) return false;
  // Still moving means still signing in.
  if (lastPrints.size !== nowPrints.size) return false;
  for (const print of nowPrints) if (!lastPrints.has(print)) return false;
  return true;
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
        ...ARENA_SIGN_IN_ARGS,
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
  // What the profile held BEFORE anybody signed in. Everything below asks
  // whether a session has appeared, not whether one exists — the difference
  // between the two is a window closed while Google was still asking for a
  // password.
  const printsBefore = authCookiePrints(dir);
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
  /** When a record this profile did not have was first noticed. */
  let newSeenAt = 0;
  let lastPrints = printsBefore;
  const outcome = await (async (): Promise<"closed" | "finished" | "timeout"> => {
    const tick = () => new Promise<"tick">((r) => setTimeout(() => r("tick"), 2_000));
    for (;;) {
      const step = await Promise.race([exited, finished, tick()]);
      if (step !== "tick") return step;
      if (Date.now() > deadline) return "timeout";
      // The session reaching the profile is the thing being waited for, so
      // it ends the wait — rather than the window closing, which on macOS
      // is not an event that happens.
      const prints = authCookiePrints(dir);
      if (hasNewAccount(printsBefore, prints)) {
        if (!newSeenAt) {
          newSeenAt = Date.now();
          logger.info("arena", "a session is being written to the profile; waiting for it to settle");
        } else if (newAccountSettled(newSeenAt, lastPrints, prints, Date.now())) {
          logger.info("arena", "the account reached the profile; closing the sign-in window");
          return "finished";
        }
      } else {
        newSeenAt = 0;
      }
      lastPrints = prints;
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
  // And the last word is the driver's, not the disk's. The poll above only
  // decides when to stop waiting; whether there is an account is settled by
  // opening the profile and asking Arena, which is the one check that can
  // tell a session that is present from a session that works.
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
