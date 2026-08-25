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

export function decryptChromiumCookieValue(encryptedValue: Buffer, aesKey: Buffer): string {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    if (prefix === "v20") {
      throw new CryptoError(
        "This browser uses app-bound encryption (v20), which cannot be decrypted by OnFlip. " +
          "Try Firefox, or provide a session token manually (--token)."
      );
    }
    throw new CryptoError(`Unsupported cookie encryption version: ${prefix}`);
  }
  const nonce = encryptedValue.subarray(3, 15);
  const ciphertext = encryptedValue.subarray(15);
  if (ciphertext.length < 16) throw new CryptoError("Cookie value too short");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
