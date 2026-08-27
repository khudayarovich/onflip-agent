import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ExtractedToken } from "./session";
import { logger } from "../log";

function workerPath(): string {
  return path.join(__dirname, "extract-worker.js");
}

/**
 * Which runtimes could run the cookie worker, best first.
 *
 * A real Node is preferred: better-sqlite3's default binding is compiled
 * against Node's ABI, and under Electron — `ELECTRON_RUN_AS_NODE`, which the
 * desktop app falls back to when the machine has no Node installed — that
 * binding refuses to load (NODE_MODULE_VERSION 137 vs 130). But Electron is
 * no longer useless here: the package ships a second binding for the
 * Electron ABI (see prebuilds/ and openCookieDb), so the app's own binary
 * goes last as the runtime of last resort. Before that, a machine with no
 * Node at all showed "install Node.js" to a user who had clicked a button
 * promising to read their browser — on the one kind of machine the desktop
 * app most needs to work on.
 */
function runtimeCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.ONFLIP_NODE) candidates.push(process.env.ONFLIP_NODE);
  // Only trust our own runtime outright when it is genuinely Node.
  if (!process.versions.electron) candidates.push(process.execPath);
  candidates.push(process.platform === "win32" ? "node.exe" : "node");
  // Electron-as-Node, carried by the bundled Electron-ABI binding.
  if (process.versions.electron) candidates.push(process.execPath);
  return [...new Set(candidates)];
}

/**
 * Both ways the cookie reader can be unavailable rather than unsuccessful:
 * no Node to run it (ENOENT on every candidate), or a Node whose ABI the
 * prebuilt binding does not match. Neither says anything about whether the
 * user has a ChatGPT session, so neither may be reported as if it did.
 */
function readerUnavailable(message: string): boolean {
  return (
    /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message) ||
    /ENOENT/.test(message)
  );
}

/**
 * Extracts the ChatGPT session token from an installed browser by running the
 * extraction in a separate (short-lived) Node process. This isolates the native
 * better-sqlite3 module from the long-lived agent process, which avoids a
 * Node 24 GC/teardown crash that occurs when a DB handle coexists with a
 * network fetch in the same process.
 */
export function spawnExtractToken(): ExtractedToken | null {
  const failures: string[] = [];

  for (const runtime of runtimeCandidates()) {
    try {
      const out = execFileSync(runtime, [workerPath()], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // stderr was discarded here, which is why an ABI mismatch surfaced as
        // a bare "no session found" with nothing to act on.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      const line = out.trim().split(/\r?\n/).pop() ?? "null";
      const parsed = JSON.parse(line) as ExtractedToken | null;
      if (parsed) {
        logger.info("auth", "read browser cookies", { runtime, source: parsed.source });
        return parsed;
      }
      // The worker ran and found nothing: a real answer, not a failure of
      // this runtime. Trying another Node would find the same nothing.
      logger.info("auth", "no browser session found", { runtime });
      return null;
    } catch (e) {
      const stderr =
        typeof (e as { stderr?: unknown }).stderr === "string"
          ? ((e as { stderr: string }).stderr ?? "").trim()
          : "";
      const message = `${e instanceof Error ? e.message : String(e)}${stderr ? ` — ${stderr}` : ""}`;
      failures.push(`${runtime}: ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }

  // Not fatal. Browsers rotate their cookie encryption — Chrome's app-bound
  // scheme in particular — and a session that has a stored token, or a
  // logged-in persistent profile, can carry on perfectly well without a
  // fresh extraction. Throwing here took all of that down over a cookie
  // OnFlip did not need, so the caller gets a null and falls through to its
  // other sources.
  const joined = failures.join(" | ");
  lastExtractError = readerUnavailable(joined)
    ? "Importing cookies from your browser needs Node.js 20+ on this machine, which the cookie reader could not find here. " +
      "Use “Sign in to ChatGPT” in the app instead — it needs nothing extra."
    : joined || "no runtime could run the cookie reader";
  logger.warn("auth", "could not read browser cookies", { failures });
  return null;
}

/** Set when the last extraction attempt failed, for the status line. */
let lastExtractError: string | null = null;

export function takeExtractError(): string | null {
  const e = lastExtractError;
  lastExtractError = null;
  return e;
}
