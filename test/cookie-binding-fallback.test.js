"use strict";

/**
 * The sqlite binding, and telling it apart from "you have no session".
 *
 * From a macOS report: Firefox held a live ChatGPT session, and OnFlip asked
 * the user to sign in. The cookie worker is run under Electron first because
 * its ABI is known in advance and the app ships a binding for it - except no
 * darwin binding was ever packaged, so every browser failed to open, and the
 * loop read "opened nothing" as "found nothing" and never asked the
 * machine's own Node.
 *
 * Two things are pinned here: the packaging (a binding for every platform the
 * app ships to, all at one ABI) and the rule that tells a runtime's own
 * failure apart from an answer about the machine.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { bindingMismatch, bindingFailedEverywhere } = require("../dist/auth/extract");

const ABI_ERROR =
  "the sqlite binding does not match this runtime (needs ABI 130), and no bundled binding for it shipped with the app";

test("the three spellings of a binding fault are all recognised", () => {
  assert.ok(bindingMismatch(ABI_ERROR), "openCookieDb's own sentence");
  assert.ok(
    bindingMismatch("Error: The module was compiled against a different Node.js version"),
    "Node's wording"
  );
  assert.ok(bindingMismatch("NODE_MODULE_VERSION 127. This version of Node.js requires 130"), "the code");
});

test("a browser that simply has no session is not a binding fault", () => {
  assert.equal(bindingMismatch("Firefox has no ChatGPT session"), false);
  assert.equal(bindingMismatch("Chrome encrypts its cookies so only Chrome can read them"), false);
  assert.equal(bindingMismatch(""), false);
});

test("every browser failing on the binding is this runtime's failure, not an answer", () => {
  const report = [
    { browser: "Firefox", outcome: "error", detail: ABI_ERROR },
    { browser: "Chrome", outcome: "error", detail: ABI_ERROR },
  ];
  assert.equal(bindingFailedEverywhere(report), true);
});

test("one real answer anywhere in the report means the machine has answered", () => {
  // The distinction that matters: if any browser was actually opened and read,
  // another runtime would find the same nothing, so the loop must stop.
  assert.equal(
    bindingFailedEverywhere([
      { browser: "Firefox", outcome: "error", detail: ABI_ERROR },
      { browser: "Chrome", outcome: "no-session" },
    ]),
    false
  );
  assert.equal(
    bindingFailedEverywhere([
      { browser: "Chrome", outcome: "app-bound" },
      { browser: "Firefox", outcome: "error", detail: ABI_ERROR },
    ]),
    false
  );
  // An error that is not about the binding is also a real finding.
  assert.equal(
    bindingFailedEverywhere([
      { browser: "Firefox", outcome: "error", detail: "cookies.sqlite is corrupt" },
    ]),
    false
  );
});

test("an empty report never triggers a retry", () => {
  // No browsers looked at is "nothing installed", which another runtime would
  // report identically - retrying would just spawn a second process for it.
  assert.equal(bindingFailedEverywhere([]), false);
});

test("a sqlite binding ships for every platform the app is released for", () => {
  // The bug was pure packaging: prebuilds held win32-x64 alone, so the macOS
  // build had nothing to fall back to and cookie import could not work there
  // at all. electron-builder releases Windows and both macOS architectures.
  const root = path.join(__dirname, "..", "prebuilds");
  const abis = {};
  for (const platform of ["win32-x64", "darwin-arm64", "darwin-x64"]) {
    const dir = path.join(root, platform);
    assert.ok(fs.existsSync(dir), `prebuilds/${platform} is missing`);
    const found = fs
      .readdirSync(dir)
      .map((f) => /^better_sqlite3-abi(\d+)\.node$/.exec(f))
      .filter(Boolean);
    assert.equal(found.length, 1, `prebuilds/${platform} should hold exactly one binding`);
    abis[platform] = found[0][1];
    assert.ok(
      fs.statSync(path.join(dir, found[0][0])).size > 500_000,
      `prebuilds/${platform} binding looks truncated`
    );
  }
  // One Electron, one ABI. Bumping Electron and re-fetching only one platform
  // is exactly how macOS was left behind the first time.
  const distinct = [...new Set(Object.values(abis))];
  assert.equal(distinct.length, 1, `platforms disagree on the ABI: ${JSON.stringify(abis)}`);
});

test("each platform's binding is actually built for that platform", () => {
  // A file of the right name that is the wrong architecture would pass every
  // check above and fail only on a user's machine.
  const root = path.join(__dirname, "..", "prebuilds");
  const binding = (platform) => {
    const dir = path.join(root, platform);
    const name = fs.readdirSync(dir).find((f) => /^better_sqlite3-abi\d+\.node$/.test(f));
    assert.ok(name, platform + " has no binding");
    return fs.readFileSync(path.join(dir, name)).subarray(0, 8);
  };

  const win = binding("win32-x64");
  assert.equal(win.subarray(0, 2).toString("latin1"), "MZ", "win32 binding should be a PE image");

  const MACH_O_64 = 0xfeedfacf;
  const CPU = { "darwin-arm64": 0x0100000c, "darwin-x64": 0x01000007 };
  for (const [platform, cpu] of Object.entries(CPU)) {
    const b = binding(platform);
    assert.equal(b.readUInt32LE(0), MACH_O_64, `${platform} binding should be Mach-O 64-bit`);
    assert.equal(b.readUInt32LE(4), cpu, `${platform} binding is the wrong architecture`);
  }
});
