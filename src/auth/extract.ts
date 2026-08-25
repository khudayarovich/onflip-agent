import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ExtractedToken } from "./session";
import { logger } from "../log";

function workerPath(): string {
  return path.join(__dirname, "extract-worker.js");
}

/**
 * Extracts the ChatGPT session token from an installed browser by running the
 * extraction in a separate (short-lived) Node process. This isolates the native
 * better-sqlite3 module from the long-lived agent process, which avoids a
 * Node 24 GC/teardown crash that occurs when a DB handle coexists with a
 * network fetch in the same process.
 */
export function spawnExtractToken(): ExtractedToken | null {
  try {
    const out = execFileSync(process.execPath, [workerPath()], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.trim().split(/\r?\n/).pop() ?? "null";
    return JSON.parse(line) as ExtractedToken | null;
  } catch (e) {
    // Not fatal. Browsers rotate their cookie encryption — Chrome's app-bound
    // scheme in particular — and a session that has a stored token, or a
    // logged-in persistent profile, can carry on perfectly well without a
    // fresh extraction. Throwing here took all of that down over a cookie
    // OnFlip did not need, so the caller gets a null and falls through to its
    // other sources.
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("auth", "could not read browser cookies", { error: msg });
    lastExtractError = msg;
    return null;
  }
}

/** Set when the last extraction attempt failed, for the status line. */
let lastExtractError: string | null = null;

export function takeExtractError(): string | null {
  const e = lastExtractError;
  lastExtractError = null;
  return e;
}
