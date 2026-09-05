"use strict";

/**
 * When Google will not accept the sign-in window.
 *
 * It does not fail outright: it navigates to a page saying the browser may
 * not be secure and sits there, so without recognising that URL the app just
 * timed out. Recognising it is half the job — the other half is saying which
 * way is still open, and the refused step is usually a passkey, which wants a
 * platform authenticator this window does not have.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "signin.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/** The module imports Electron at the top; only pure exports are used here. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-signin";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-signin"] = {
    id: "electron-stub-signin",
    filename: "electron-stub-signin",
    loaded: true,
    exports: {
      app: { commandLine: { appendSwitch() {} }, getPath: () => "", userAgentFallback: "" },
      BrowserWindow: class {},
      session: { fromPartition: () => ({ webRequest: { onBeforeSendHeaders() {} } }) },
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

test("Google's rejection pages are recognised", { skip: needsBuild }, () => {
  const { isGoogleRefusal } = load();
  for (const url of [
    "https://accounts.google.com/v3/signin/rejected?rrk=48",
    "https://accounts.google.com/signin/rejected?disallowed_useragent=1",
    "https://accounts.google.com/x/deniedsigninrejected",
  ]) {
    assert.equal(isGoogleRefusal(url), true, url);
  }
});

test("an ordinary Google sign-in page is not a refusal", { skip: needsBuild }, () => {
  const { isGoogleRefusal } = load();
  assert.equal(isGoogleRefusal("https://accounts.google.com/v3/signin/identifier"), false);
  assert.equal(isGoogleRefusal("https://chatgpt.com/auth/login"), false);
});

test("the refusal leads with the escape hatch on the page itself", { skip: needsBuild }, () => {
  // "Try another way" walks past a passkey prompt without leaving the window,
  // so it comes before the advice that means going somewhere else and
  // coming back.
  const { GOOGLE_REFUSAL_HELP } = load();
  assert.match(GOOGLE_REFUSAL_HELP, /Try another way/);
  assert.match(GOOGLE_REFUSAL_HELP, /passkey/);
  assert.ok(
    GOOGLE_REFUSAL_HELP.indexOf("Try another way") < GOOGLE_REFUSAL_HELP.indexOf("Use my browser"),
    "the in-window fix should be offered before the one that sends the user away"
  );
});
