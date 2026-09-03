import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionCookie } from "./access";
import type { BrowserCookieLocation } from "./browser";

/**
 * Safari's cookie store, for Macs where Safari is the only browser signed in.
 *
 * Safari keeps its cookies in `Cookies.binarycookies`, a small binary format
 * that is not encrypted at all — the protection is macOS's own: the file sits
 * inside Safari's container, and reading it needs the reading app to have
 * been granted Full Disk Access. Refused, the read fails with EPERM, and the
 * honest answer is to say which setting to change rather than "no session".
 *
 * Format (public knowledge, stable since 10.7): "cook", a big-endian page
 * count, big-endian page sizes, then the pages. A page opens with 0x00000100,
 * a little-endian cookie count and little-endian cookie offsets. A cookie
 * record is little-endian throughout: its size, four unknown bytes, flags,
 * four more, then the offsets of domain, name, path and value relative to the
 * record, an eight-byte end marker, two doubles (expiry and creation, seconds
 * since 2001), and the four NUL-terminated strings.
 */

export interface SafariCookie {
  domain: string;
  name: string;
  value: string;
  path: string;
}

function cString(buf: Buffer, at: number): string {
  if (at < 0 || at >= buf.length) return "";
  const end = buf.indexOf(0, at);
  return buf.toString("utf8", at, end < 0 ? buf.length : end);
}

/** Every cookie in a binarycookies file; a malformed page is skipped, not fatal. */
export function parseBinaryCookies(buf: Buffer): SafariCookie[] {
  const out: SafariCookie[] = [];
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== "cook") return out;
  const pages = buf.readUInt32BE(4);
  let cursor = 8 + pages * 4;
  for (let i = 0; i < pages; i++) {
    const size = buf.readUInt32BE(8 + i * 4);
    const page = buf.subarray(cursor, cursor + size);
    cursor += size;
    try {
      if (page.length < 8 || page.readUInt32BE(0) !== 0x00000100) continue;
      const count = page.readUInt32LE(4);
      for (let c = 0; c < count; c++) {
        const at = page.readUInt32LE(8 + c * 4);
        const record = page.subarray(at, at + page.readUInt32LE(at));
        if (record.length < 56) continue;
        const domain = cString(record, record.readUInt32LE(16));
        const name = cString(record, record.readUInt32LE(20));
        const cookiePath = cString(record, record.readUInt32LE(24));
        const value = cString(record, record.readUInt32LE(28));
        if (name) out.push({ domain, name, value, path: cookiePath });
      }
    } catch {
      /* a page that does not add up is skipped; the others still count */
    }
  }
  return out;
}

const SESSION_DOMAINS = ["chatgpt.com", "openai.com"];

function belongsToSession(domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  return SESSION_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The ChatGPT cookies out of a binarycookies file, hosts in stable order. */
export function chatGptCookiesFromBinaryCookies(buf: Buffer): SessionCookie[] {
  const seen = new Map<string, SessionCookie>();
  const mine = parseBinaryCookies(buf)
    .filter((c) => belongsToSession(c.domain))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  for (const c of mine) {
    if (!seen.has(c.name)) seen.set(c.name, { name: c.name, value: c.value });
  }
  return [...seen.values()];
}

/** Where Safari keeps the file; the container path on every macOS still supported. */
export function findSafariCookieLocations(): BrowserCookieLocation[] {
  if (process.platform !== "darwin") return [];
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies"),
    path.join(home, "Library", "Cookies", "Cookies.binarycookies"),
  ];
  const results: BrowserCookieLocation[] = [];
  for (const file of candidates) {
    // existsSync is false for a path the sandbox refuses to stat, which is
    // the Full Disk Access case; the read is attempted anyway so the refusal
    // surfaces as EPERM and can be explained, rather than as "not installed".
    if (fs.existsSync(file) || fs.existsSync(path.dirname(path.dirname(file)))) {
      results.push({ browser: "Safari", localStatePath: "", cookieDbPath: file });
      break;
    }
  }
  return results;
}

/** What a refused read means on macOS, in the words the user needs. */
export const SAFARI_ACCESS_HINT =
  "grant OnFlip Full Disk Access in System Settings → Privacy & Security, then check again";
