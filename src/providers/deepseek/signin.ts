import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { checkSignedIn, closeBrowser } from "./browser";
import { DEEPSEEK_SIGN_IN_URL, TOKEN_KEY, deepseekProfileDir } from "./session";

/**
 * Signing in to DeepSeek, in a browser DeepSeek's identity providers accept.
 *
 * An ordinary Chrome, started the way a person starts one, on the profile
 * OnFlip will later drive. No debugging port, no automation switches, no
 * driver attached — so "Sign in with Google" is a Google sign-in in Google
 * Chrome, and goes through.
 *
 * That last part is the whole reason this exists rather than a login inside
 * the app's own window. Google blocks OAuth from embedded browsers on
 * purpose, as their enforcement of RFC 8252, and four separate fingerprint
 * fixes — user agent, brand list, `navigator.webdriver`, an empty
 * `window.chrome` — each corrected a real tell and none of them changed the
 * answer. Verified the other way round too: this flow was signed in with
 * Google on the first attempt.
 *
 * Like ChatGPT's version, this watches the profile from outside and closes
 * the window the moment the session lands. DeepSeek keeps its session in
 * localStorage rather than a cookie, but a fresh write sits uncompressed in
 * the profile's LevelDB `.log`, which can be copied and scanned for the
 * `userToken` record exactly the way ChatGPT's flow scans the cookie
 * database — an accelerator, not the proof; the profile is still opened and
 * asked afterwards. Before this watch existed the flow waited for the person
 * to close the window or press the app's Done button, and the field showed
 * what that costs: people trained by the ChatGPT flow signed in and then
 * waited, with the window and the app both waiting on them.
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
 * process and exit at once, and the window it opened stays on screen. Treating
 * that exit as "the user closed the window" checked the profile a second after
 * it was created, found nothing, and told someone who was still typing their
 * password that there was no session.
 */
const HANDOFF_MS = 8_000;

export type SignInProgress = "waiting" | "verifying";

export interface DeepSeekSignInResult {
  ok: boolean;
  /** The account id, when the profile ended up with one. */
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
  // read — closing it here with a hard kill raced Chrome's own flush of the
  // localStorage it had just written.
  declareFinished?.();
}

export function cancelSignIn(): void {
  cancelled = true;
  declareFinished?.();
}

/**
 * Close the sign-in window the way the browser's own Quit does, and wait for
 * the process to actually be gone before anything touches the profile.
 *
 * Two separate failures live in the difference. `child.kill()` is
 * TerminateProcess on Windows — a hard kill, which can lose the last writes,
 * and the token this window existed to write is the last write there is. And
 * returning before the exit let the verification open a profile the exiting
 * Chrome still held, which read as "no session" to someone who had just
 * signed in. ChatGPT's flow learned both lessons first (`closeGracefully`);
 * this is the same shape.
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
 * Is there a `userToken` with a real value in the profile on disk?
 *
 * A record written in the last few minutes sits uncompressed in the Local
 * Storage LevelDB `.log`, as the key's bytes followed by the JSON the page
 * stored — `{"value":"…"}` signed in, `{"value":null}` signed out — so a
 * byte scan of a *copy* of each file answers without opening the profile.
 * Compaction moves old records into Snappy-compressed `.ldb` blocks a plain
 * scan cannot see, which is why a negative here means nothing and only the
 * sign-in flow, where the write is seconds old, may ask.
 */
function tokenOnDisk(dir: string): boolean {
  const root = path.join(dir, "Default", "Local Storage", "leveldb");
  let files: string[];
  try {
    files = fs.readdirSync(root);
  } catch {
    return false;
  }
  const key = Buffer.from(TOKEN_KEY);
  const real = Buffer.from('{"value":"');
  for (const f of files) {
    if (!/\.log$/i.test(f)) continue;
    const tmp = path.join(os.tmpdir(), `onflip-ds-signin-${process.pid}-${Date.now()}`);
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
      // The value follows the key within a few framing bytes; a null value
      // (signed out) never matches `{"value":"`.
      if (buf.subarray(at + key.length, at + key.length + 24).indexOf(real) !== -1) return true;
    }
  }
  return false;
}

export async function signInWithRealBrowser(
  onProgress?: (state: SignInProgress) => void
): Promise<DeepSeekSignInResult> {
  if (child) return { ok: false, reason: "A DeepSeek sign-in window is already open." };

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
    // does not name Chrome — the same refusal the embedded panel gets.
    logger.warn("deepseek", "only the bundled browser is available; a Google sign-in may be refused");
  }

  // Nothing else may hold the profile: a second browser on the same directory
  // refuses to start, and the driver may be sitting on it from an earlier run.
  await closeBrowser();

  const dir = deepseekProfileDir();
  fs.mkdirSync(dir, { recursive: true });
  cancelled = false;

  const args = [
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    ...(process.platform === "linux" ? ["--password-store=basic"] : []),
    DEEPSEEK_SIGN_IN_URL,
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
  logger.info("deepseek", "sign-in window opened", { channel: pick.channel });
  onProgress?.("waiting");

  const finished = new Promise<"finished">((resolve) => {
    declareFinished = () => resolve("finished");
  });
  const exited = new Promise<"closed">((resolve) => {
    const done = () => {
      const openFor = Date.now() - startedAt;
      child = null;
      if (openFor >= HANDOFF_MS) return resolve("closed");
      // Chrome handed the window to another process and this one is finished.
      // The window is still on screen, so keep waiting for the person at it.
      logger.info("deepseek", "the launcher exited immediately; the window is another process", {
        afterMs: openFor,
      });
    };
    started.once("exit", done);
    started.once("error", done);
  });
  const deadline = Date.now() + DEADLINE_MS;
  // Wait for whichever comes first: the session reaching the profile (the
  // ordinary end — the window is then closed for the person, the way
  // ChatGPT's sign-in closes itself), the window closing, the app's Done
  // button, or the deadline.
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
    logger.info("deepseek", "the session reached the profile; closing the sign-in window");
  }
  // Whatever ended the wait, nothing may touch the profile until the browser
  // is gone: closing gracefully is what flushes the session to disk.
  await closeWindowGracefully();
  child = null;
  if (outcome === "timeout") {
    return {
      ok: false,
      reason: "The sign-in window was open for fifteen minutes without a session. Try again when you are ready.",
    };
  }
  if (cancelled) return { ok: false, reason: "cancelled" };

  // The window is done with, so the profile can be opened and asked — after a
  // moment, because Chrome flushes its localStorage on the way out and the
  // directory is locked until it has.
  onProgress?.("verifying");
  await new Promise((r) => setTimeout(r, 1_500));
  const check = await checkSignedIn({ tries: 5 });
  await closeBrowser();
  if (check.signedIn) {
    logger.info("deepseek", "signed in", { account: check.account ?? "unknown" });
    return { ok: true, account: check.account };
  }
  // The page check and the profile disagree: the token is on disk but the
  // driven page did not show it. The disk is the direct evidence — believe
  // it, and let the account name fall back to "DeepSeek account" — but log
  // the disagreement loudly; it is the line that will name whatever kept the
  // page from hydrating on this machine.
  if (tokenOnDisk(dir)) {
    logger.warn("deepseek", "the page check saw no session but the profile holds a token; believing the profile", {
      pageError: check.error ?? null,
    });
    return { ok: true };
  }
  if (check.error) {
    // Not the same as being signed out, and saying so saves the user from
    // signing in again to fix something a sign-in cannot fix.
    logger.warn("deepseek", "the profile could not be read after sign-in", { error: check.error });
    return {
      ok: false,
      reason: `OnFlip could not open the DeepSeek profile to check the session (${check.error.split("\n")[0].slice(0, 140)}). Close any Chrome window still using it and try again.`,
    };
  }
  return {
    ok: false,
    reason:
      "The window closed without a DeepSeek session. If you did sign in, open the sign-in again and use the button in OnFlip to finish rather than closing the window yourself.",
  };
}
