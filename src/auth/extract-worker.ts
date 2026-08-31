import { extractSessionTokenFromBrowser, lastBrowserReport } from "./session";

/**
 * Runs the cookie search in a short-lived process and prints the result as one
 * JSON line.
 *
 * The per-browser report travels with the answer because a failure on someone
 * else's machine is only debuggable if it says which browsers were found and
 * what each one did — "no session found" alone sent people looking for a bug
 * in their account.
 */
let result: ReturnType<typeof extractSessionTokenFromBrowser> = null;
let error: string | undefined;
try {
  result = extractSessionTokenFromBrowser();
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}

process.stdout.write(
  JSON.stringify(
    result
      ? { ...result, report: lastBrowserReport() }
      : { report: lastBrowserReport(), error }
  ) + "\n"
);
