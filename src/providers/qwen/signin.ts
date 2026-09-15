import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { checkSignedIn, closeBrowser } from "./browser";
import { QWEN_SIGN_IN_URL, TOKEN_KEY, qwenProfileDir } from "./session";

/**
 * Signing in to Qwen, in a browser Qwen's identity providers accept.
 *
 * The same flow DeepSeek's sign-in uses, and for the same reason: an
 * ordinary Chrome, started the way a person starts one, on the profile
 * OnFlip will later drive. No debugging port, no automation switches, no
 * driver attached — so "Continue with Google" is a Google sign-in in Google
 * Chrome, and goes through. Google blocks OAuth from embedded browsers as a
 * matter of policy, and four separate fingerprint fixes each corrected a
 * real tell without changing the answer.
 *
 * Qwen makes that choice more pointed than DeepSeek did. Alibaba's own
 * risk-control stack runs on the page, so a driven browser is not merely
 * refused by Google at the door — it is the thing the site is watching for.
 * A real Chrome that a person signed into is what it is meant to see.
 */

let child: ChildProcess | null = null;
let cancelled = false;
/** Resolved when the user says they are done, whatever the window is doing. */
let declareFinished: (() => void) | null = null;

/**
 * Below this, the process exiting is Chrome handing off, not a user finishing.
 *
 * On Windows the `chrome.exe` that is started does not always become the
 * browser: with a `--user-data-dir` of its own it can spawn the real browser
 * process and exit at once, and the window it opened stays on screen.
 */
const HANDOFF_MS = 8_000;

export type SignInProgress = "waiting" | "verifying";

export interface QwenSignInResult {
  ok: boolean;
  /** The account name, when the profile ended up showing one. */
  account?: string;
  /** Why it did not succeed: "cancelled" | "timeout" | an error message. */
  reason?: string;
}

/** Long enough for a slow login and a two-step prompt; not forever. */
const DEADLINE_MS = 15 * 60_000;

export function signInRunning(): boolean {
  return child !== null || declareFinished !== null;
}

/** The user says they are done; stop waiting and check the profile. */
export function finishSignIn(): void {
  // The window is closed by the main flow, gracefully, before the profile is
  // read — a hard kill here races Chrome's own flush of the localStorage it
  // has just written, which is the one write this window exists to make.
  declareFinished?.();
}

export function cancelSignIn(): void {
  cancelled = true;
  declareFinished?.();
}

/**
 * Close the sign-in window the way the browser's own Quit does, and wait for
 * the process to be gone before anything touches the profile.
 *
 * Two separate failures live in the difference, both of them learned on
 * ChatGPT's flow and then on DeepSeek's: `child.kill()` is TerminateProcess
 * on Windows and can lose the last writes, and returning before the exit
 * lets the verification open a profile the exiting Chrome still holds, which
 * reads as "no session" to someone who has just signed in.
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
 * Is there a `token` holding a JWT in the profile on disk?
 *
 * A record written in the last few minutes sits uncompressed in the Local
 * Storage LevelDB `.log`, so a byte scan of a *copy* answers without opening
 * the profile — an accelerator that lets the window close itself the moment
 * the session lands, rather than leaving someone who has finished waiting
 * for a button.
 *
 * Qwen's key is the single word `token`, which is far too common a string to
 * scan for on its own: the page's own analytics blob is 190KB of JSON in the
 * same database and full of the word. So the match is framed — Chrome writes
 * a localStorage record as the origin, a 0x01 separator, then the key — and
 * the value has to look like the JWT this key holds. A false positive here
 * would close the window on somebody mid-password, which is why it is framed
 * rather than merely narrowed.
 *
 * A negative means nothing either way: compaction moves older records into
 * compressed blocks a plain scan cannot see. Only the sign-in flow, where
 * the write is seconds old, may ask — and the profile is still opened and
 * asked properly afterwards.
 */
function tokenOnDisk(dir: string): boolean {
  const root = path.join(dir, "Default", "Local Storage", "leveldb");
  let files: string[];
  try {
    files = fs.readdirSync(root);
  } catch {
    return false;
  }
  // 0x01 is the separator Chrome writes between the origin and the key.
  const key = Buffer.concat([Buffer.from([1]), Buffer.from(TOKEN_KEY)]);
  // Every JWT header begins `{"` , which base64url encodes to `eyJ`.
  const jwt = Buffer.from("eyJ");
  for (const f of files) {
    if (!/\.log$/i.test(f)) continue;
    const tmp = path.join(os.tmpdir(), `onflip-qwen-signin-${process.pid}-${Date.now()}`);
    let buf: Buffer;
    try {
      fs.copyFileSync(path.join(root, f), tmp);
      buf = fs.readFileSync(tmp);
    } catch {
      continue; // held by the running browser; the next poll asks again
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    let at = -1;
    while ((at = buf.indexOf(key, at + 1)) !== -1) {
      // The value follows the key within a few framing bytes. A signed-out
      // profile has no such record at all, and a cleared one holds an empty
      // value, neither of which matches.
      if (buf.subarray(at + key.length, at + key.length + 12).indexOf(jwt) !== -1) return true;
    }
  }
  return false;
}

export async function signInWithRealBrowser(
  onProgress?: (state: SignInProgress) => void
): Promise<QwenSignInResult> {
  if (child) return { ok: false, reason: "A Qwen sign-in window is already open." };

  const pick = pickSignInBrowser();
  if (!pick) {
    return {
      ok: false,
      reason:
        "No browser to sign in with was found. Install Google Chrome or Microsoft Edge and try again.",
    };
  }
  if (pick.channel === "chromium") {
    // Worth saying rather than letting it fail at Google's door: the bundled
    // build is Chromium, and Google refuses a sign-in from a brand list that
    // does not name Chrome.
    logger.warn("qwen", "only the bundled browser is available; a Google sign-in may be refused");
  }

  // Nothing else may hold the profile: a second browser on the same
  // directory refuses to start, and the driver may be sitting on it.
  await closeBrowser();

  const dir = qwenProfileDir();
  fs.mkdirSync(dir, { recursive: true });
  cancelled = false;

  const args = [
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    ...(process.platform === "linux" ? ["--password-store=basic"] : []),
    QWEN_SIGN_IN_URL,
  ];

  let started: ChildProcess;
  try {
    started = spawn(pick.executable, args, { stdio: "ignore", windowsHide: false });
  } catch (e) {
    return {
      ok: false,
      reason: `Could not start ${pick.name}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  child = started;
  const startedAt = Date.now();
  logger.info("qwen", "sign-in window opened", { channel: pick.channel });
  onProgress?.("waiting");

  const finished = new Promise<"finished">((resolve) => {
    declareFinished = () => resolve("finished");
  });
  const exited = new Promise<"closed">((resolve) => {
    const done = () => {
      const openFor = Date.now() - startedAt;
      child = null;
      if (openFor >= HANDOFF_MS) return resolve("closed");
      // Chrome handed the window to another process and this one is
      // finished. The window is still on screen, so keep waiting.
      logger.info("qwen", "the launcher exited immediately; the window is another process", {
        afterMs: openFor,
      });
    };
    started.once("exit", done);
    started.once("error", done);
  });
  const deadline = Date.now() + DEADLINE_MS;
  const outcome = await (async (): Promise<"closed" | "finished" | "timeout" | "token"> => {
    const tick = () => new Promise<"tick">((r) => setTimeout(() => r("tick"), 2_000));
    for (;;) {
      const step = await Promise.race([exited, finished, tick()]);
      if (step !== "tick") return step;
      if (Date.now() > deadline) return "timeout";
      if (tokenOnDisk(dir)) return "token";
    }
  })();
  declareFinished = null;
  if (outcome === "token") {
    logger.info("qwen", "the session reached the profile; closing the sign-in window");
  }
  // Whatever ended the wait, nothing may touch the profile until the browser
  // is gone: closing gracefully is what flushes the session to disk.
  await closeWindowGracefully();
  child = null;
  if (outcome === "timeout") {
    return {
      ok: false,
      reason:
        "The sign-in window was open for fifteen minutes without a session. Try again when you are ready.",
    };
  }
  if (cancelled) return { ok: false, reason: "cancelled" };

  onProgress?.("verifying");
  await new Promise((r) => setTimeout(r, 1_500));
  const check = await checkSignedIn({ tries: 5 });
  await closeBrowser();
  if (check.signedIn) {
    logger.info("qwen", "signed in", { account: check.account ?? "unknown" });
    return { ok: true, account: check.account };
  }
  // The page check and the profile disagree: the token is on disk but the
  // driven page did not show it. The disk is the direct evidence — believe
  // it, and let the account name fall back to "Qwen account" — but log the
  // disagreement loudly.
  if (tokenOnDisk(dir)) {
    logger.warn("qwen", "the page check saw no session but the profile holds a token; believing the profile", {
      pageError: check.error ?? null,
    });
    return { ok: true };
  }
  if (check.error) {
    logger.warn("qwen", "the profile could not be read after sign-in", { error: check.error });
    return {
      ok: false,
      reason: `OnFlip could not open the Qwen profile to check the session (${check.error.split("\n")[0].slice(0, 140)}). Close any Chrome window still using it and try again.`,
    };
  }
  return {
    ok: false,
    reason:
      "The window closed without a Qwen session. If you did sign in, open the sign-in again and use the button in OnFlip to finish rather than closing the window yourself.",
  };
}
