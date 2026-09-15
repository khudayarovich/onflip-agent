import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
 * Every token record the profile holds on disk, as fingerprints.
 *
 * This used to answer a much worse question — *is there a token?* — and the
 * assumption written beside it, that a signed-out profile has no such
 * record, is false. Qwen leaves an expired token in localStorage at full
 * length and correct shape. So on any profile whose session had lapsed the
 * answer was yes the instant the window opened, the sign-in window closed
 * itself about two seconds later, and the flow then read that same stale
 * token, found it well-formed and reported a successful sign-in.
 *
 * What the person saw: Chrome opening and closing before they could type,
 * an app that claimed to be signed in, a message that went nowhere, and a
 * sign-in prompt again. Round and round. Verified against a real lapsed
 * profile rather than reasoned about - the scan matched at offset 4710 of
 * 000004.log with nobody having signed in at all.
 *
 * The question that is actually worth asking is whether a token has
 * APPEARED, which needs the set from before the window opened. A set, not
 * one value: the log is append-only, so an old record and a new one sit in
 * it together and the first match may still be the stale one.
 *
 * Fingerprints rather than the values themselves. Nothing here needs the
 * token, and a credential held in a variable for no reason is a credential
 * that can be logged by accident.
 *
 * Qwen's key is the single word `token`, far too common to scan for alone -
 * the page's own analytics blob is 190KB of JSON in the same database. So
 * the match is framed: Chrome writes a localStorage record as the origin, a
 * 0x01 separator, then the key, and the value has to look like a JWT.
 *
 * An empty set means nothing either way: compaction moves older records
 * into compressed blocks a plain scan cannot see. Only the sign-in flow,
 * where the write is seconds old, may ask - and the profile is still opened
 * and asked properly afterwards.
 */
function tokenPrints(dir: string): Set<string> {
  const out = new Set<string>();
  const root = path.join(dir, "Default", "Local Storage", "leveldb");
  let files: string[];
  try {
    files = fs.readdirSync(root);
  } catch {
    return out;
  }
  // 0x01 is the separator Chrome writes between the origin and the key.
  const key = Buffer.concat([Buffer.from([1]), Buffer.from(TOKEN_KEY)]);
  // Every JWT header begins `{"`, which base64url encodes to `eyJ`.
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
      const after = buf.subarray(at + key.length, at + key.length + 12);
      const lead = after.indexOf(jwt);
      if (lead === -1) continue;
      // Enough of the value to tell two tokens apart, hashed so the token
      // itself is never carried around.
      const value = buf.subarray(at + key.length + lead, at + key.length + lead + 160);
      out.add(createHash("sha256").update(value).digest("hex").slice(0, 16));
    }
  }
  return out;
}

/** A token this profile did not have before the window opened. */
export function hasNewToken(before: Set<string>, now: Set<string>): boolean {
  for (const print of now) if (!before.has(print)) return true;
  return false;
}

/**
 * Did a sign-in actually happen?
 *
 * `pageSaysSignedIn` is the profile holding a well-formed token, and a
 * lapsed Qwen session leaves exactly that behind - so on its own it comes
 * back true for somebody who cancelled, closed the window, or failed at
 * the password. That is the second door into the sign-in loop, and it is
 * not closed by fixing the accelerator alone.
 *
 * Narrow on purpose. It refuses only when the profile ALREADY held a token
 * and no new one arrived, which is the one case that cannot be a sign-in.
 * A profile that held none is left to the page check, so a genuine first
 * sign-in still succeeds even if compaction hides the write from the byte
 * scan - being wrong in that direction would break signing in altogether,
 * which is worse than the loop this exists to stop.
 */
export function isRealSignIn(opts: {
  pageSaysSignedIn: boolean;
  hadTokenBefore: boolean;
  newTokenAppeared: boolean;
}): boolean {
  if (!opts.pageSaysSignedIn) return false;
  return opts.newTokenAppeared || !opts.hadTokenBefore;
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
  // What the profile held BEFORE anybody signed in. Everything below asks
  // whether a token has appeared, not whether one exists - the difference
  // between the two is the sign-in loop this flow used to produce on any
  // profile whose session had lapsed.
  const printsBefore = tokenPrints(dir);
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
      if (hasNewToken(printsBefore, tokenPrints(dir))) return "token";
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
  const fresh = hasNewToken(printsBefore, tokenPrints(dir));
  const check = await checkSignedIn({ tries: 5 });
  await closeBrowser();

  // The second door into the same loop, and the one the accelerator fix alone
  // would have left open.
  //
  // `checkSignedIn` asks whether the profile holds a well-formed token, and a
  // lapsed Qwen session leaves exactly that behind. So closing the sign-in
  // window without signing in — or cancelling, or signing in and failing —
  // still came back "signed in", on the strength of the token that was there
  // when the window opened. The next message went to a guest chat and the
  // sign-in prompt came round again.
  //
  // The rule is narrow on purpose. It refuses only when the profile ALREADY
  // held a token and no new one arrived, which is the case that cannot be a
  // sign-in. A profile that had none is left to the check, so a genuine first
  // sign-in still succeeds even if the write is hidden from the byte scan by
  // compaction — being wrong in that direction would break signing in
  // altogether, which is worse than the loop this is fixing.
  const real = isRealSignIn({
    pageSaysSignedIn: check.signedIn,
    hadTokenBefore: printsBefore.size > 0,
    newTokenAppeared: fresh,
  });
  if (real) {
    logger.info("qwen", "signed in", { account: check.account ?? "unknown", fresh });
    return { ok: true, account: check.account };
  }
  if (check.signedIn && !real) {
    logger.warn("qwen", "the profile holds only the token it already had; not treating this as a sign-in", {
      had: printsBefore.size,
    });
    return {
      ok: false,
      reason:
        "The window closed without a new Qwen session — the one already in the profile has expired. Open the sign-in again and complete it, then use the button in OnFlip to finish.",
    };
  }
  // The page check and the profile disagree: the token is on disk but the
  // driven page did not show it. The disk is the direct evidence — believe
  // it, and let the account name fall back to "Qwen account" — but log the
  // disagreement loudly.
  if (hasNewToken(printsBefore, tokenPrints(dir))) {
    // A token that was not there before, and a page check that could not
    // see it. The disk is the direct evidence of a sign-in having
    // happened, so it is believed - but only because it is NEW. Believing
    // a token that was already there is what reported a successful
    // sign-in to somebody who never got the chance to type one.
    logger.warn("qwen", "the page check saw no session but a new token reached the profile; believing the disk", {
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
