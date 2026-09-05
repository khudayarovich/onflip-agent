import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ExtractedToken, BrowserReport } from "./session";
import { logger } from "../log";

/** Per-browser findings from the last search, for the message and the log. */
let lastReport: BrowserReport[] = [];

export function lastBrowserFindings(): BrowserReport[] {
  return lastReport;
}

/**
 * Turn the report into one sentence a user can act on.
 *
 * The "act on" half matters more than the diagnosis. Chrome 127 and later
 * encrypt cookies so that only Chrome can read them — app-bound encryption,
 * which is the point of it and not a fault here or a thing a future version
 * will fix. Reported as a bare failure it reads as OnFlip being broken, and
 * the obvious next move (signing in through the app's own window, which
 * needs nothing at all) goes unmentioned. So when that is the only thing
 * standing in the way, the sentence says so and says what to do instead.
 */
export function describeReport(report: BrowserReport[]): string {
  const parts = report.map((r) => {
    if (r.outcome === "app-bound") return `${r.browser} encrypts its cookies so only ${r.browser} can read them`;
    if (r.outcome === "locked") return `${r.browser} is open — close it and try again`;
    if (r.outcome === "error") return `${r.browser} could not be read (${r.detail ?? "unknown"})`;
    return `${r.browser} has no ChatGPT session`;
  });
  if (!parts.length) return "No supported browser was found on this machine.";

  // Only when app-bound encryption is the whole story. If some other browser
  // merely has no session, closing it or signing in there is still the
  // shorter path and the advice would be wrong.
  const blocked = report.some((r) => r.outcome === "app-bound");
  const otherwiseFixable = report.some((r) => r.outcome === "locked" || r.outcome === "needs-access");
  if (blocked && !otherwiseFixable) {
    return (
      `${parts.join("; ")}. ` +
      "That is how those browsers are built, not a fault OnFlip can fix. " +
      "Use “Sign in to ChatGPT” in the app instead — it opens its own window and needs nothing set up."
    );
  }
  return `${parts.join("; ")}.`;
}

function workerPath(): string {
  return path.join(__dirname, "extract-worker.js");
}

/**
 * Which runtimes could run the cookie worker, best first.
 *
 * Electron first, deliberately. better-sqlite3's binding is compiled per ABI,
 * and the machine's own Node is a lottery: a build made on Node 24 (ABI 137)
 * fails on Node 22 (127) and Node 20 (115), which is exactly what happened —
 * every browser on one machine reported the same "compiled against a
 * different Node.js version" and the user was told no session existed. The
 * app ships a binding for Electron's ABI, so running the worker under
 * Electron is the one choice whose ABI is known in advance.
 *
 * The engine itself runs under plain Node, where `process.versions.electron`
 * is undefined, so the shell passes Electron's path in ONFLIP_ELECTRON_PATH.
 * A real Node stays in the list behind it, for the case where the bundled
 * binding is missing but the machine's own happens to match.
 */
function runtimeCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.ONFLIP_NODE) candidates.push(process.env.ONFLIP_NODE);
  // Electron, whose ABI matches the binding this package ships.
  if (process.versions.electron) candidates.push(process.execPath);
  if (process.env.ONFLIP_ELECTRON_PATH) candidates.push(process.env.ONFLIP_ELECTRON_PATH);
  // Then whatever Node is around, which may or may not match.
  if (!process.versions.electron) candidates.push(process.execPath);
  candidates.push(process.platform === "win32" ? "node.exe" : "node");
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
      const parsed = JSON.parse(line) as
        | (ExtractedToken & { report?: BrowserReport[] })
        | { report?: BrowserReport[]; error?: string }
        | null;
      lastReport = (parsed as { report?: BrowserReport[] })?.report ?? [];
      if (parsed && "cookies" in parsed && parsed.cookies.length) {
        logger.info("auth", "read browser cookies", {
          runtime,
          source: parsed.source,
          cookies: parsed.cookies.length,
          report: lastReport,
        });
        return parsed;
      }
      // The worker ran and found nothing: a real answer, not a failure of
      // this runtime. Trying another Node would find the same nothing.
      logger.info("auth", "no browser session found", { runtime, report: lastReport });
      const workerError = (parsed as { error?: string })?.error;
      lastExtractError = workerError || describeReport(lastReport);
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
