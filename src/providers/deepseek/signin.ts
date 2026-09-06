import * as fs from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "../../log";
import { pickSignInBrowser } from "../../chatgpt/browser-client";
import { checkSignedIn, closeBrowser } from "./browser";
import { DEEPSEEK_SIGN_IN_URL, deepseekProfileDir } from "./session";

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
 * Where it differs from ChatGPT's version: ChatGPT watches the profile's
 * cookie database and closes the window the moment a session appears.
 * DeepSeek keeps its session in localStorage, which lives in a LevelDB that
 * is locked while the browser is open, so there is nothing safe to watch.
 * This waits for the window to close instead and then asks the profile
 * directly. One extra click, and no chance of misreading a half-written file.
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
  closeWindow();
  declareFinished?.();
}

export function cancelSignIn(): void {
  cancelled = true;
  closeWindow();
  declareFinished?.();
}

function closeWindow(): void {
  const running = child;
  if (!running) return;
  try {
    running.kill();
  } catch {
    /* already gone */
  }
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
  const deadline = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), DEADLINE_MS)
  );
  const outcome = await Promise.race([exited, finished, deadline]);
  declareFinished = null;
  child = null;
  if (outcome === "timeout") {
    closeWindow();
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
  if (check.error) {
    // Not the same as being signed out, and saying so saves the user from
    // signing in again to fix something a sign-in cannot fix.
    logger.warn("deepseek", "the profile could not be read after sign-in", { error: check.error });
    return {
      ok: false,
      reason: `OnFlip could not open the DeepSeek profile to check the session (${check.error.split("\n")[0].slice(0, 140)}). Close any Chrome window still using it and try again.`,
    };
  }
  if (!check.signedIn) {
    return {
      ok: false,
      reason:
        "The window closed without a DeepSeek session. If you did sign in, open the sign-in again and use the button in OnFlip to finish rather than closing the window yourself.",
    };
  }
  logger.info("deepseek", "signed in", { account: check.account ?? "unknown" });
  return { ok: true, account: check.account };
}
