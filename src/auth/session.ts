import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  allCookieLocations,
  BrowserCookieLocation,
} from "./browser";
import { decryptChromiumCookieValue, getAesKeyFromLocalState, CryptoError } from "./crypto";
import { SessionCookie } from "./access";

const SESSION_COOKIE = "__Secure-next-auth.session-token";

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
  const aesKey = getAesKeyFromLocalState(loc.localStatePath);
  const { file, cleanup } = readWithCopy(loc.cookieDbPath);
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });

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
        const value = decryptChromiumCookieValue(row.encrypted_value, aesKey);
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
    const db = new Database(file, { readonly: true, fileMustExist: true });

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
export function extractSessionTokenFromBrowser(): ExtractedToken | null {
  const tried: string[] = [];
  let appBound: CryptoError | null = null;

  for (const loc of allCookieLocations()) {
    if (!tried.includes(loc.browser)) tried.push(loc.browser);
    try {
      const result =
        loc.browser === "Firefox" ? extractFirefox(loc) : extractChromium(loc);
      if (result) return result;
    } catch (e) {
      if (e instanceof CryptoError && e.message.includes("v20")) {
        // Worth reporting only if nothing else pans out.
        appBound = appBound ?? e;
      }
      // Any other failure is this browser's problem, not the search's.
    }
  }

  if (appBound) {
    throw new CryptoError(
      `No ChatGPT session could be read from any browser (tried ${tried.join(
)}). ` +
        `Chrome-family cookies use app-bound encryption, which cannot be decrypted. ` +
        `Sign in through OnFlip's own browser with \`onflip login --headed\`, ` +
        `or pass a token with --token.`
    );
  }
  return null;
}
