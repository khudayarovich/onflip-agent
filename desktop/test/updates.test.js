"use strict";

/**
 * Which build an update would fetch, and when it would offer one.
 *
 * These are the two decisions in the updater that can be wrong quietly. A
 * bad version comparison offers an update forever or never; a bad asset
 * choice downloads the wrong file for the machine and fails at the last
 * step, after the download the user waited for.
 *
 * Both are pure. The parts that are not — the download and the hand-off to
 * the installer — need a real Electron runtime and a real release, and are
 * exercised by running the app rather than from here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

/**
 * Load the compiled updater with `electron` stubbed.
 *
 * The module imports `app` and `net` at the top, and neither exists outside
 * an Electron process. Only the pure exports are used here, so a stub that
 * answers `getVersion` is enough.
 */
const DIST = path.join(__dirname, "..", "dist", "electron", "updates.js");
/**
 * The engine's CI job builds `src/` and not the desktop app, and the root
 * runner discovers every `*.test.js` in the repository — so this file has to
 * be able to sit out rather than fail. It runs locally and in the desktop
 * job, which does build it. Skipping loudly beats a red build that means
 * "you did not compile the other package".
 */
const built = fs.existsSync(DIST);
const needsBuild = built ? false : "desktop/dist is not built (run: cd desktop && npm run build:node)";

function loadUpdates() {
  const dist = DIST;
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub"] = {
    id: "electron-stub",
    filename: "electron-stub",
    loaded: true,
    exports: { app: { getVersion: () => "0.8.6" }, net: { request: () => ({}) } },
  };
  try {
    delete require.cache[require.resolve(dist)];
    return require(dist);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

const updates = built ? loadUpdates() : null;

/**
 * Run `fn` as though this were another machine.
 *
 * The platform is read at *call* time, not when the module loads, so the
 * override has to be in place around the call itself — restoring it before
 * calling made every platform look like this one, which is how the first
 * version of this file passed while testing nothing.
 */
function onPlatform(platform, arch, fn) {
  const p = Object.getOwnPropertyDescriptor(process, "platform");
  const a = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    return fn(updates);
  } finally {
    if (p) Object.defineProperty(process, "platform", p);
    if (a) Object.defineProperty(process, "arch", a);
  }
}

/** A release shaped like the ones this project actually publishes. */
const RELEASE = {
  tag_name: "desktop-v0.8.7",
  assets: [
    { name: "OnFlip-Setup-0.8.7.exe", browser_download_url: "https://x/OnFlip-Setup-0.8.7.exe" },
    { name: "OnFlip-Setup-0.8.7.exe.blockmap", browser_download_url: "https://x/blockmap" },
    { name: "OnFlip-0.8.7-mac-arm64.dmg", browser_download_url: "https://x/arm64.dmg" },
    { name: "OnFlip-0.8.7-mac-arm64.zip", browser_download_url: "https://x/arm64.zip" },
    { name: "OnFlip-0.8.7-mac-x64.dmg", browser_download_url: "https://x/x64.dmg" },
    { name: "OnFlip-0.8.7-mac-x64.zip", browser_download_url: "https://x/x64.zip" },
  ],
};

// ---------------------------------------------------------------------------
// which build to fetch
// ---------------------------------------------------------------------------

test("Windows takes the installer", { skip: needsBuild }, () => {
  const hit = onPlatform("win32", "x64", (u) => u.installableAssetFor(RELEASE));
  assert.equal(hit.name, "OnFlip-Setup-0.8.7.exe");
});

test("macOS takes the zip for its own architecture, not the dmg", { skip: needsBuild }, () => {
  // The zip holds the .app directly, so the swap needs no disk image mounted.
  // A human downloading by hand still gets the dmg — that is `assetFor`.
  const arm = onPlatform("darwin", "arm64", (u) => u.installableAssetFor(RELEASE));
  assert.equal(arm.name, "OnFlip-0.8.7-mac-arm64.zip");

  const intel = onPlatform("darwin", "x64", (u) => u.installableAssetFor(RELEASE));
  assert.equal(intel.name, "OnFlip-0.8.7-mac-x64.zip");
});

test("an Apple Silicon machine never gets the Intel build", { skip: needsBuild }, () => {
  // Silent and expensive if wrong: it downloads, installs, and runs slowly
  // under Rosetta, or refuses.
  const arm = onPlatform("darwin", "arm64", (u) => u.installableAssetFor(RELEASE));
  assert.ok(!arm.name.includes("x64"), `wrong architecture: ${arm.name}`);
});

test("a platform with no build gets nothing rather than the wrong thing", { skip: needsBuild }, () => {
  const hit = onPlatform("linux", "x64", (u) => u.installableAssetFor(RELEASE));
  assert.equal(hit, undefined);
});

test("a release missing this platform's asset offers nothing", { skip: needsBuild }, () => {
  // Then the caller falls back to opening the release page, which is what
  // the app did before it could install at all.
  onPlatform("win32", "x64", (u) => {
    assert.equal(u.installableAssetFor({ assets: [{ name: "notes.txt", browser_download_url: "u" }] }), undefined);
    assert.equal(u.installableAssetFor({}), undefined);
  });
});

test("the blockmap beside the installer is never chosen", { skip: needsBuild }, () => {
  // It sits next to the .exe in every release and is not runnable.
  const hit = onPlatform("win32", "x64", (u) => u.installableAssetFor(RELEASE));
  assert.ok(!hit.name.endsWith(".blockmap"));
});

// ---------------------------------------------------------------------------
// when to offer one
// ---------------------------------------------------------------------------

test("a later version is newer, an earlier one is not", { skip: needsBuild }, () => {
  const { isNewer } = updates;
  assert.equal(isNewer("0.8.7", "0.8.6"), true);
  assert.equal(isNewer("0.9.0", "0.8.9"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.8.5", "0.8.6"), false);
});

test("the same version is not an update", { skip: needsBuild }, () => {
  // Otherwise the banner returns after every check, for ever.
  const { isNewer } = updates;
  assert.equal(isNewer("0.8.6", "0.8.6"), false);
});

test("double-digit patches sort numerically, not as text", { skip: needsBuild }, () => {
  // The bug string comparison would give: "0.8.9" > "0.8.10".
  const { isNewer } = updates;
  assert.equal(isNewer("0.8.10", "0.8.9"), true);
  assert.equal(isNewer("0.8.9", "0.8.10"), false);
  assert.equal(isNewer("0.10.0", "0.9.0"), true);
});
