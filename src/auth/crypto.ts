import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";

export class CryptoError extends Error {}

function dpapiUnprotect(base64Blob: string): Buffer {
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$b = [Convert]::FromBase64String('${base64Blob}')`,
    "$b = $b[5..($b.Length-1)]",
    "$u = [System.Security.Cryptography.ProtectedData]::Unprotect([byte[]]$b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($u)",
  ].join("; ");
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const b64 = out.trim().split(/\r?\n/).filter(Boolean).pop()?.trim();
    if (!b64) throw new CryptoError("DPAPI: empty output");
    return Buffer.from(b64, "base64");
  } catch (e) {
    throw new CryptoError(
      `DPAPI decryption failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export function getAesKeyFromLocalState(localStatePath: string): Buffer {
  const raw = require("node:fs").readFileSync(localStatePath, "utf8");
  const state = JSON.parse(raw);
  const encryptedKey: string | undefined = state?.os_crypt?.encrypted_key;
  if (!encryptedKey) throw new CryptoError("Local State missing os_crypt.encrypted_key");
  const key = dpapiUnprotect(encryptedKey);
  if (key.length !== 32) throw new CryptoError(`Unexpected AES key length: ${key.length}`);
  return key;
}


/**
 * The password Chromium keeps in the OS keyring, used to derive the cookie key
 * on macOS and Linux. Windows encrypts the key with DPAPI instead — see
 * `getAesKeyFromLocalState`.
 *
 * On macOS this asks the user's own Keychain, and macOS may show a permission
 * prompt the first time; that prompt is the user allowing their own machine to
 * read their own cookies, and there is no way around it that would be honest.
 */
function keyringPassword(browser: string): string {
  if (process.platform === "darwin") {
    const service = `${browser} Safe Storage`;
    try {
      return execFileSync("security", ["find-generic-password", "-wa", browser, "-s", service], {
        encoding: "utf8",
        timeout: 20_000,
      }).trim();
    } catch (e) {
      throw new CryptoError(
        `macOS Keychain did not release the "${service}" key` +
          " — allow OnFlip when the Keychain prompt appears, or sign in through the app's window instead."
      );
    }
  }

  // Linux: the desktop keyring when one is running, and Chromium's documented
  // fallback password when the browser was started without one.
  for (const args of [
    ["lookup", "application", "chrome"],
    ["lookup", "application", "chromium"],
  ]) {
    try {
      const out = execFileSync("secret-tool", args, { encoding: "utf8", timeout: 10_000 }).trim();
      if (out) return out;
    } catch {
      /* no secret-tool, or nothing stored under that key */
    }
  }
  return "peanuts";
}

/**
 * The cookie key for this platform, and the cipher that goes with it.
 *
 * Chromium uses AES-256-GCM with a DPAPI-protected key on Windows, and
 * AES-128-CBC with a PBKDF2-derived key everywhere else. Getting the pair
 * wrong decrypts to noise rather than failing loudly, so they travel together.
 */
export interface CookieKey {
  key: Buffer;
  scheme: "gcm" | "cbc";
}

export function getCookieKey(localStatePath: string, browser: string): CookieKey {
  if (process.platform === "win32") {
    return { key: getAesKeyFromLocalState(localStatePath), scheme: "gcm" };
  }
  const password = keyringPassword(browser);
  const iterations = process.platform === "darwin" ? 1003 : 1;
  const key = crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  return { key, scheme: "cbc" };
}

export function decryptChromiumCookieValue(
  encryptedValue: Buffer,
  cookieKey: CookieKey
): string {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    if (prefix === "v20") {
      throw new CryptoError(
        // Not a limitation to work around: app-bound encryption ties the key
        // to Chrome itself, so no other program is meant to read these and
        // none can. Worth saying outright, because worded as a failure it
        // sends people looking for a fix that does not exist.
        "This browser uses app-bound encryption (v20): only the browser itself can read its cookies, " +
          "so no other program can import them. Sign in through the app's own window instead — " +
          "it needs nothing set up. (Firefox does not do this, if you would rather import.)"
      );
    }
    throw new CryptoError(`Unsupported cookie encryption version: ${prefix}`);
  }

  if (cookieKey.scheme === "cbc") {
    // macOS and Linux: AES-128-CBC, initialisation vector of sixteen spaces.
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv("aes-128-cbc", cookieKey.key, iv);
    const plain = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
    // Recent Chromium prefixes the value with a 32-byte hash of the domain.
    const text = plain.toString("utf8");
    return plain.length > 32 && !/^[ -~]/.test(text) ? plain.subarray(32).toString("utf8") : text;
  }

  const nonce = encryptedValue.subarray(3, 15);
  const ciphertext = encryptedValue.subarray(15);
  if (ciphertext.length < 16) throw new CryptoError("Cookie value too short");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", cookieKey.key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
