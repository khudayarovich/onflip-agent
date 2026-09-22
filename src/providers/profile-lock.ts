import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Freeing a browser profile that a previous browser is still holding.
 *
 * Chromium allows one process per `--user-data-dir` and enforces it with a
 * lock it calls the ProcessSingleton. A second launch on a held directory
 * does not wait or warn; it fails outright, and Playwright surfaces the
 * refusal as `Failed to create a ProcessSingleton for your profile
 * directory`.
 *
 * Which is exactly what OnFlip's sign-in does. It opens a real Chrome on the
 * provider's profile so the person can log in, closes it, then opens the same
 * directory with Playwright to read the session back. If anything is still
 * holding it at that moment, the read fails and the app reports that it could
 * not check the session — to somebody who has just signed in successfully.
 *
 * Two ways that happens, and the first is not a bug in anything:
 *
 *   macOS keeps an application running when its last window closes. The
 *   sign-in instructions say to close the window once the chat appears, and
 *   on a Mac that leaves Chrome alive in the Dock, still holding the lock.
 *   The same instruction on Windows ends the process.
 *
 *   A hard kill leaves the lock behind. The graceful close gives the browser
 *   ten seconds and then sends SIGKILL, which does not run Chromium's own
 *   cleanup, so the lock outlives the process that made it.
 *
 * Both are safe to resolve here, and only because of whose directory this is.
 * These are OnFlip's private per-provider profiles — nothing else on the
 * machine has any reason to open one — so a process holding the lock is a
 * browser OnFlip started, and ending it takes nothing from the person using
 * the computer. This must never be pointed at a profile a real browser
 * shares, which is why it takes a directory rather than finding them.
 */

/** Chromium's lock, and the two sockets that belong with it. */
const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/**
 * The process id out of a lock's target, or null if it does not name one.
 *
 * On macOS and Linux the lock is a symlink whose target is
 * `<hostname>-<pid>`. The hostname is whatever the machine is called and may
 * itself contain dashes — `iMays-Mac-mini-4821` is one lock, not four — so
 * the pid is the last dash-separated field and nothing else can be assumed.
 *
 * Pure, because getting it wrong means either failing to free a profile that
 * needed freeing or signalling a process id that was never in the string.
 */
export function pidFromLockTarget(target: string): number | null {
  const m = /-(\d{1,10})$/.exec((target ?? "").trim());
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The machine name out of a lock's target, or null.
 *
 * Everything before the pid — which is the hostname, dashes and all. On a
 * junction (how the tests make a lock on Windows) the target is a whole path,
 * so only its last segment is read.
 */
export function hostFromLockTarget(target: string): string | null {
  const m = /^(.*)-\d{1,10}$/.exec(path.basename((target ?? "").trim()));
  return m && m[1] ? m[1] : null;
}

/** What `releaseProfileLock` asks of the machine before it signals anything. */
export interface LockInspection {
  hostname(): string;
  /** A running process's command line, or null when it cannot be read. */
  commandLine(pid: number): string | null;
}

const SYSTEM: LockInspection = {
  hostname: () => os.hostname(),
  commandLine(pid) {
    try {
      if (process.platform === "linux") {
        return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
      }
      return (
        execFileSync("ps", ["-p", String(pid), "-o", "args="], {
          encoding: "utf8",
          timeout: 3_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null
      );
    } catch {
      return null;
    }
  },
};

/** Is this process still running? Signal 0 checks without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to somebody else, which still counts
    // as alive — and on these profiles cannot happen, since we started it.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

export type LockOutcome =
  /** Nothing was holding it. */
  | "free"
  /** Something was, and is not any more. */
  | "released"
  /** Something is, and would not let go. */
  | "held";

/**
 * Make sure nothing is holding this profile, and say what had to happen.
 *
 * Windows is deliberately left alone. Its lock carries no process id to read,
 * so there is nothing to check liveness against — and deleting a lock whose
 * owner is alive is how a profile gets corrupted rather than opened. The
 * failure is also much rarer there, because closing the window ends the
 * process.
 */
export async function releaseProfileLock(
  dir: string,
  note?: (message: string, data?: Record<string, unknown>) => void,
  // Injected so the POSIX path can be exercised from a Windows machine.
  // Not a nicety: every macOS fault in this driver's history was shipped by
  // someone who could not run the macOS branch, and a default parameter is
  // the difference between testing this and hoping about it.
  platform: string = process.platform,
  inspect: LockInspection = SYSTEM
): Promise<LockOutcome> {
  if (platform === "win32") return "free";

  const lock = path.join(dir, "SingletonLock");
  let target: string;
  try {
    target = fs.readlinkSync(lock);
  } catch {
    // No lock, or not a symlink. Either way there is nothing to free.
    return "free";
  }

  // A pid is only this browser's while it runs on this machine and holds
  // this profile. The pid alone was trusted, so a lock surviving a reboot, a
  // reused pid, or a lock written under another machine name got some
  // unrelated process of the user's sent SIGTERM and then SIGKILL — Chromium
  // itself checks the host before it believes a lock, and this did not.
  const pid = pidFromLockTarget(target);
  const host = hostFromLockTarget(target);
  if (pid && host !== inspect.hostname()) {
    note?.("the lock was left under another machine name; clearing it without signalling anything", {
      pid,
      host,
    });
  } else if (pid && isAlive(pid)) {
    const args = inspect.commandLine(pid);
    if (args === null) {
      note?.("a process holds the profile's lock and could not be identified; leaving it alone", { pid });
      return "held";
    }
    if (!args.includes(dir)) {
      note?.("the lock names a process that is not this profile's browser; clearing the stale lock", { pid });
      return clearLockFiles(dir, pid, note);
    }
    note?.("a browser is still holding the profile; closing it", { pid, target });
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* it went away between the check and the signal */
    }
    if (!(await waitForExit(pid, 8_000))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* likewise */
      }
      if (!(await waitForExit(pid, 3_000))) {
        note?.("the profile is still held and would not release", { pid });
        return "held";
      }
    }
  }

  // The owner is gone — either it already was, or it is now. The lock it
  // left is what the next launch would refuse on, so it goes too.
  return clearLockFiles(dir, pid, note);
}

function clearLockFiles(
  dir: string,
  pid: number | null,
  note?: (message: string, data?: Record<string, unknown>) => void
): LockOutcome {
  for (const name of LOCK_FILES) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* not there, or not ours to remove; the launch will say so */
    }
  }
  note?.("released a stale profile lock", { pid: pid ?? null });
  return "released";
}
