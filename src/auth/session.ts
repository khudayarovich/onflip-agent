import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  allCookieLocations,
  knownBrowserNames,
  BrowserCookieLocation,
} from "./browser";
import { decryptChromiumCookieValue, getCookieKey, CryptoError } from "./crypto";
import { SessionCookie, pickSessionCookie } from "./access";
import { chatGptCookiesFromBinaryCookies, SAFARI_ACCESS_HINT } from "./safari";

/**
 * Open a cookie database under whatever runtime this process happens to be.
 *
 * better-sqlite3's own binding is prebuilt for Node's ABI. On a machine with
 * no Node installed, the desktop app runs everything under Electron-as-Node —
 * a different ABI — and the require fails with NODE_MODULE_VERSION 137 vs
 * 130. That failure used to end cookie import entirely: the user clicked
 * "sign in with my browser's session" and was told to go install Node.
 *
 * So the package carries a second binding, prebuilt for the Electron ABI the
 * desktop app ships (see prebuilds/), and the ABI that fails to load falls
 * back to the binding that matches `process.versions.modules`. Node and
 * Electron ABI numbers never collide, so the number alone picks the file.
 */
function openCookieDb(file: string): Database.Database {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const wrongAbi = /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(
      message
    );
    if (!wrongAbi) throw e;
    const bundled = bundledBinding();
    if (!bundled) {
      throw new Error(
        `the sqlite binding does not match this runtime (needs ABI ${process.versions.modules}), ` +
          "and no bundled binding for it shipped with the app"
      );
    }
    return new Database(file, { readonly: true, fileMustExist: true, nativeBinding: bundled });
  }
}

/** The shipped binding for this runtime's ABI, or null when there is none. */
function bundledBinding(): string | null {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    `better_sqlite3-abi${process.versions.modules}.node`
  );
  return fs.existsSync(file) ? file : null;
}

export interface ExtractedToken {
  cookies: SessionCookie[];
  primary: SessionCookie;
  deviceId?: string;
  source: string;
}

function readWithCopy(dbPath: string): { file: string; cleanup: () => void } {
  const tmp = path.join(
    os.tmpdir(),
    `onflip-cookies-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
  );
  fs.copyFileSync(dbPath, tmp);
  for (const suffix of ["-wal", "-shm"]) {
    const side = dbPath + suffix;
    if (fs.existsSync(side)) {
      try { fs.copyFileSync(side, tmp + suffix); } catch { /* best effort */ }
    }
  }
  return {
    file: tmp,
    cleanup: () => {
      for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * A jar with no session token is not a session.
 *
 * A browser that has visited chatgpt.com without signing in still has
 * cookies for it — a device id, Cloudflare's — and those used to come back
 * as a "session" with the longest of them standing in as the token. The
 * search then stopped at that browser, and the stand-in got stored. Null
 * here reads as "no session in this browser", and the search moves on.
 */
function asSession(
  cookies: SessionCookie[],
  deviceId: string | undefined,
  source: string
): ExtractedToken | null {
  const primary = pickSessionCookie(cookies);
  if (!primary) return null;
  return { cookies, primary, deviceId, source };
}

/** Closing must never be what keeps the temporary copy from being removed. */
function closeQuietly(db: Database.Database | null): void {
  try {
    db?.close();
  } catch {
    /* already closed, or never fully opened */
  }
}

function extractChromium(loc: BrowserCookieLocation): ExtractedToken | null {
  // The key and its cipher differ per platform; they are fetched together so
  // a Windows key can never be handed to the macOS cipher.
  const cookieKey = getCookieKey(loc.localStatePath, loc.browser);
  const { file, cleanup } = readWithCopy(loc.cookieDbPath);
  // Declared out here so the handle is closed whatever the query does. A
  // prepare or read that threw used to leave it open, and an open handle on
  // the temporary copy is exactly what stops Windows deleting that copy.
  let db: Database.Database | null = null;
  try {
    db = openCookieDb(file);

    const allRows = db
      .prepare(
        `SELECT name, encrypted_value FROM cookies
         WHERE host_key LIKE '%chatgpt.com' OR host_key LIKE '%openai.com'
         ORDER BY host_key`
      )
      .all() as { name: string; encrypted_value: Buffer }[];

    const cookies: SessionCookie[] = [];
    let deviceId: string | undefined;

    for (const row of allRows) {
      try {
        const value = decryptChromiumCookieValue(row.encrypted_value, cookieKey);
        cookies.push({ name: row.name, value });
        if (row.name === "oai-did") deviceId = value;
      } catch (e) {
        if (e instanceof CryptoError && e.message.includes("v20")) throw e;
        // skip undecryptable cookies
      }
    }

    if (!cookies.length) return null;
    return asSession(cookies, deviceId, loc.browser);
  } finally {
    closeQuietly(db);
    cleanup();
  }
}

function extractFirefox(loc: BrowserCookieLocation): ExtractedToken | null {
  const { file, cleanup } = readWithCopy(loc.cookieDbPath);
  let db: Database.Database | null = null;
  try {
    db = openCookieDb(file);

    const allRows = db
      .prepare(
        `SELECT name, value FROM moz_cookies
         WHERE host LIKE '%chatgpt.com' OR host LIKE '%openai.com'
         ORDER BY host`
      )
      .all() as { name: string; value: string }[];

    if (!allRows.length) return null;

    const cookies: SessionCookie[] = allRows.map((r) => ({ name: r.name, value: r.value }));
    const deviceId = cookies.find((c) => c.name === "oai-did")?.value;

    return asSession(cookies, deviceId, loc.browser);
  } finally {
    closeQuietly(db);
    cleanup();
  }
}

/**
 * Find a ChatGPT session in any installed browser.
 *
 * Every location is tried, and one that cannot be read is skipped rather
 * than ending the search. That distinction matters: Chrome's app-bound
 * encryption (v20) used to throw straight out of this loop, so Edge and
 * Firefox were never reached — while the very error it threw suggested
 * trying Firefox. A machine with a signed-in Firefox looked like a machine
 * with no session at all.
 */
/** Read one location. Injectable so the search itself can be tested. */
export type CookieReader = (loc: BrowserCookieLocation) => ExtractedToken | null;

const defaultReader: CookieReader = (loc) =>
  loc.browser === "Firefox"
    ? extractFirefox(loc)
    : loc.browser === "Safari"
      ? extractSafari(loc)
      : extractChromium(loc);

/** Safari: a plain file, read whole; macOS decides whether that is allowed. */
function extractSafari(loc: BrowserCookieLocation): ExtractedToken | null {
  const cookies = chatGptCookiesFromBinaryCookies(fs.readFileSync(loc.cookieDbPath));
  if (!cookies.length) return null;
  const deviceId = cookies.find((c) => c.name === "oai-did")?.value;
  return asSession(cookies, deviceId, loc.browser);
}

/** What each installed browser had to say, for the message and the log. */
export interface BrowserReport {
  browser: string;
  outcome:
    | "session"
    | "no-session"
    | "app-bound"
    | "locked"
    | "needs-access"
    | "error"
    | "not-installed";
  detail?: string;
}

let lastReport: BrowserReport[] = [];

/** Per-browser findings from the last search. */
export function lastBrowserReport(): BrowserReport[] {
  return lastReport;
}

export function extractSessionTokenFromBrowser(
  locations: BrowserCookieLocation[] = allCookieLocations(),
  read: CookieReader = defaultReader
): ExtractedToken | null {
  const tried: string[] = [];
  let appBound: CryptoError | null = null;
  const report: BrowserReport[] = [];
  const note = (browser: string, outcome: BrowserReport["outcome"], detail?: string) => {
    if (!report.some((r) => r.browser === browser && r.outcome === outcome)) {
      report.push({ browser, outcome, detail });
    }
  };

  for (const loc of locations) {
    if (!tried.includes(loc.browser)) tried.push(loc.browser);
    try {
      const result = read(loc);
      if (result) {
        note(loc.browser, "session");
        lastReport = report;
        return result;
      }
      note(loc.browser, "no-session");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof CryptoError && message.includes("v20")) {
        appBound = appBound ?? e;
        note(loc.browser, "app-bound");
      } else if (loc.browser === "Safari" && /EPERM|EACCES|not permitted|ENOENT/i.test(message)) {
        // macOS refusing the read, not Safari being busy: the fix is a
        // setting, and saying so is the whole value of this row.
        note(loc.browser, "needs-access", SAFARI_ACCESS_HINT);
      } else if (/EBUSY|EPERM|locked/i.test(message)) {
        note(loc.browser, "locked", "close the browser and try again");
      } else {
        note(loc.browser, "error", message.slice(0, 120));
      }
      // Any other failure is this browser's problem, not the search's.
    }
  }
  // Anything never reached is not installed, or has no cookie store where
  // one was expected. Either way the honest answer is that there was
  // nothing here to read, which beats leaving the row out.
  for (const name of knownBrowserNames()) {
    if (!report.some((r) => r.browser === name)) {
      report.push({ browser: name, outcome: "not-installed" });
    }
  }
  lastReport = report;

  if (appBound) {
    throw new CryptoError(
      `No ChatGPT session could be read from any browser (tried ${tried.join(", ")}). ` +
        `Chrome-family cookies use app-bound encryption, which cannot be decrypted. ` +
        `Sign in with the browser button instead: it opens Chrome or Edge on OnFlip's own profile.`
    );
  }
  return null;
}
