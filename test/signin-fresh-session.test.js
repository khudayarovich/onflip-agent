"use strict";

/**
 * A session the person has just signed in with gets its own chance.
 *
 * `storedJarSpent` marks the stored cookie jar as tried and lost, so the
 * page's anonymous-recovery does not loop on it. It was reset only when a
 * newly signed-in jar was injected; a real-browser sign-in leaves the new
 * session in the profile and injects nothing, so the flag outlived it, and
 * the first page to load before its cookies settled was declared expired —
 * fatally, with no reload — straight after a successful sign-in.
 *
 * The sign-in drives a real browser and cannot run here; checked in the
 * source.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("a real-browser sign-in clears the spent-jar flag", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chatgpt", "browser-client.ts"), "utf8");
  const flow = source.slice(source.indexOf("export async function signInWithRealBrowser("));
  const success = flow.slice(0, flow.indexOf("return { ok: true, browser: pick };"));
  assert.match(success.slice(-600), /storedJarSpent = false;\s*sessionSuspect = false;\s*$/);
});
