"use strict";

/**
 * Why an automatic update did not start.
 *
 * Reported as "why does the update button open GitHub instead of updating?".
 * It does install in place on both Windows and macOS — but when a pre-flight
 * check fails it falls back to the download page, and it used to do that in
 * silence, which reads as the feature not existing.
 *
 * Worse, all three ways of not starting answered "no installable build for
 * this platform", and only one of them was that. The check re-runs at click
 * time against api.github.com unauthenticated — 60 requests an hour per
 * address, shared with the poll on a timer — so the likeliest reason is a
 * failed request, not an unsupported platform. Told the wrong one, someone
 * goes looking for a missing artifact that is sitting right there.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "updates.js");
// The engine's CI job builds src/ and not the desktop app, and the root
// runner discovers every *.test.js in the repository - so this file has to
// be able to sit out rather than fail. It runs locally and in the desktop
// job, which does build it.
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/**
 * Load the compiled updater with `electron` stubbed.
 *
 * The module imports `app` and `net` at the top and neither exists outside
 * an Electron process - and CI installs the desktop package without the
 * Electron binary on purpose, because nothing here needs to run a browser.
 * Only the pure export is used, so a stub is enough. Same approach as
 * updates.test.js, which reaches the same module for the same reason.
 */
function loadUpdates() {
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
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

const load = () => loadUpdates().whyNotInstallable;

const INSTALLABLE = { url: "https://example.invalid/a.zip", name: "a.zip" };

test("a check that could not run says so, and quotes the failure", { skip: needsBuild }, () => {
  const whyNotInstallable = load();
  const why = whyNotInstallable({ error: "HTTP 403", available: false });
  assert.match(why, /update check failed/);
  assert.match(why, /403/, "the actual failure is carried through");
  assert.doesNotMatch(why, /platform/, "and it is not blamed on the platform");
});

test("rate limiting is the common case and must not read as unsupported", { skip: needsBuild }, () => {
  const whyNotInstallable = load();
  // The one that sent this question: 60 requests an hour, shared with the
  // timer, and a 403 that looks like nothing in particular.
  const why = whyNotInstallable({ error: "HTTP 403 rate limit exceeded", available: false });
  assert.match(why, /rate limit/);
  assert.doesNotMatch(why, /no build|no installable/);
});

test("already up to date is its own answer", { skip: needsBuild }, () => {
  const whyNotInstallable = load();
  assert.equal(whyNotInstallable({ available: false }), "no newer release was found");
});

test("a platform with no artifact is named precisely", { skip: needsBuild }, () => {
  const whyNotInstallable = load();
  const why = whyNotInstallable({ available: true, installable: undefined }, "linux", "x64");
  assert.match(why, /linux\/x64/, "says which platform, so it can be checked against the release");
});

test("nothing in the way returns null, and the install proceeds", { skip: needsBuild }, () => {
  const whyNotInstallable = load();
  assert.equal(whyNotInstallable({ available: true, installable: INSTALLABLE }), null);
});

test("an error outranks the other two", { skip: needsBuild }, () => {
  const whyNotInstallable = load();
  // A failed check leaves `available` false and `installable` undefined, so
  // order decides which reason is reported — and the error is the true one.
  const why = whyNotInstallable({ error: "socket hang up", available: false, installable: undefined });
  assert.match(why, /socket hang up/);
});

test("a release still being published is named as that, not as anything else", { skip: needsBuild }, () => {
  // During the upload window the older answers were both lies: "no newer
  // release" stops somebody looking, and "no build for this platform" sends
  // them hunting for an artifact that is minutes from existing.
  const whyNotInstallable = load();
  const why = whyNotInstallable({ available: false, pending: "9.9.9" });
  assert.match(why, /9\.9\.9/);
  assert.match(why, /still being published/);
  assert.match(why, /try again/);
});
