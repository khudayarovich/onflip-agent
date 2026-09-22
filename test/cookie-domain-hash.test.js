"use strict";

/**
 * A Chromium cookie value comes back without the domain hash in front of it.
 *
 * Since cookie database version 24 (Chromium 130) the encrypted blob holds
 * SHA256(host_key) followed by the value, on every platform. The Windows
 * branch (AES-GCM) never removed it, so a session imported from Edge came
 * back as thirty-two bytes of binary followed by the token. The macOS and
 * Linux branch (AES-CBC) guessed — strip unless the first byte is printable
 * — and a hash starts with a printable byte about a third of the time:
 * auth.openai.com's does. With the cookie's own host the check is exact.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { decryptChromiumCookieValue } = require("../dist/auth/crypto");

const sha = (host) => crypto.createHash("sha256").update(host).digest();

function gcmBlob(key, plain) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
}

function cbcBlob(key, plain) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

const TOKEN = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..example-session-token-value";
const gcm = { key: crypto.randomBytes(32), scheme: "gcm" };
const cbc = { key: crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"), scheme: "cbc" };

test("Windows: the domain hash is removed", () => {
  const blob = gcmBlob(gcm.key, Buffer.concat([sha("chatgpt.com"), Buffer.from(TOKEN)]));
  assert.equal(decryptChromiumCookieValue(blob, gcm, "chatgpt.com"), TOKEN);
});

test("macOS and Linux: removed even when the hash starts with a printable byte", () => {
  // auth.openai.com's hash begins with "b", which the old guess kept.
  assert.ok(/^[ -~]/.test(sha("auth.openai.com").toString("latin1")), "the case this test exists for");
  const blob = cbcBlob(cbc.key, Buffer.concat([sha("auth.openai.com"), Buffer.from("abc123value")]));
  assert.equal(decryptChromiumCookieValue(blob, cbc, "auth.openai.com"), "abc123value");
});

test("a value from before the hash was added is left whole", () => {
  // The false-positive half: an older database has no prefix, and a value
  // longer than 32 bytes must not lose its first 32.
  assert.equal(decryptChromiumCookieValue(gcmBlob(gcm.key, Buffer.from(TOKEN)), gcm, "chatgpt.com"), TOKEN);
  assert.equal(decryptChromiumCookieValue(cbcBlob(cbc.key, Buffer.from(TOKEN)), cbc, "chatgpt.com"), TOKEN);
  // And a hash of some other host is not this cookie's prefix.
  const other = gcmBlob(gcm.key, Buffer.concat([sha("example.com"), Buffer.from("v")]));
  assert.equal(decryptChromiumCookieValue(other, gcm, "chatgpt.com").endsWith("v"), true);
  assert.equal(decryptChromiumCookieValue(other, gcm, "chatgpt.com").length > 1, true);
});

test("the cookie reader hands each row's host to the decryptor", () => {
  // The reader needs a real browser database and the native sqlite binding,
  // which the engine CI job does not install; the call is checked in the
  // source instead.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "auth", "session.ts"), "utf8");
  assert.match(source, /decryptChromiumCookieValue\(row\.encrypted_value, cookieKey, row\.host_key\)/);
});
