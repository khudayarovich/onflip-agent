import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  allCookieLocations,
  BrowserCookieLocation,
} from "./browser";
import { decryptChromiumCookieValue, getCookieKey, CryptoError } from "./crypto";
import { SessionCookie } from "./access";

const SESSION_COOKIE = "__Secure-next-auth.session-token";

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
    if (!bundled) throw e;
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

function pickPrimary(cookies: SessionCookie[]): SessionCookie {
  const order = (n: string) =>
    n === SESSION_COOKIE ? 0 : n.endsWith(".0") ? 1 : n.endsWith(".1") ? 2 : 3;
  return [...cookies].sort(
    (a, b) => order(a.name) - order(b.name) || b.value.length - a.value.length
  )[0];
}

function extractChromium(loc: BrowserCookieLocation): ExtractedToken | null {
  // The key and its cipher differ per platform; they are fetched together so
  // a Windows key can never be handed to the macOS cipher.
  const cookieKey = getCookieKey(loc.localStatePath, loc.browser);
  const { file, cleanup } = readWithCopy(loc.cookieDbPath);
  try {
    const db = openCookieDb(file);

    const allRows = db
      .prepare(
        `SELECT name, encrypted_value FROM cookies
         WHERE host_key LIKE '%chatgpt.com' OR host_key LIKE '%openai.com'
         ORDER BY host_key`
      )
      .all() as { name: string; encrypted_value: Buffer }[];

    db.close();

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
    return { cookies, primary: pickPrimary(cookies), deviceId, source: loc.browser };
  } finally {
    cleanup();
  }
}

function extractFirefox(loc: BrowserCookieLocation): ExtractedToken | null {
  const { file, cleanup } = readWithCopy(loc.cookieDbPath);
  try {
    const db = openCookieDb(file);

    const allRows = db
      .prepare(
        `SELECT name, value FROM moz_cookies
         WHERE host LIKE '%chatgpt.com' OR host LIKE '%openai.com'
         ORDER BY host`
      )
      .all() as { name: string; value: string }[];

    db.close();

    if (!allRows.length) return null;

    const cookies: SessionCookie[] = allRows.map((r) => ({ name: r.name, value: r.value }));
    const deviceId = cookies.find((c) => c.name === "oai-did")?.value;

    return { cookies, primary: pickPrimary(cookies), deviceId, source: loc.browser };
  } finally {
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
  loc.browser === "Firefox" ? extractFirefox(loc) : extractChromium(loc);

/** What each installed browser had to say, for the message and the log. */
export interface BrowserReport {
  browser: string;
  outcome: "session" | "no-session" | "app-bound" | "locked" | "error";
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
      } else if (/EBUSY|EPERM|locked/i.test(message)) {
        note(loc.browser, "locked", "close the browser and try again");
      } else {
        note(loc.browser, "error", message.slice(0, 120));
      }
      // Any other failure is this browser's problem, not the search's.
    }
  }
  lastReport = report;

  if (appBound) {
    throw new CryptoError(
      `No ChatGPT session could be read from any browser (tried ${tried.join(
)}). ` +
        `Chrome-family cookies use app-bound encryption, which cannot be decrypted. ` +
        `Sign in to ChatGPT in Firefox, which OnFlip can read, or use the app's own sign-in window.`
    );
  }
  return null;
}
