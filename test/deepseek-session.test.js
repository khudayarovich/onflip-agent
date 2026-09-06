"use strict";

/**
 * What counts as a signed-in DeepSeek profile.
 *
 * Not a cookie, which is the first surprise. Read from a genuinely signed-in
 * profile, chat.deepseek.com held only `aws-waf-token`, `smidV2` and a
 * thumbnail cache — nothing authenticating. The session is a `userToken`
 * entry in localStorage, wrapped as `{"value":"…","__version":"0"}`.
 *
 * The consequence is the part worth protecting: ChatGPT's sign-in can watch
 * its cookie database from outside and close the window the moment a session
 * lands, and DeepSeek's cannot, because localStorage lives in a LevelDB that
 * is locked while the browser is open. So the rule about what a valid session
 * looks like has to be exactly right — it is checked once, after the window
 * closes, with no second chance to notice.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-ds-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_PROVIDER;

const {
  isSignedIn,
  accountId,
  isSignInPage,
  deepseekProfileDir,
  TOKEN_KEY,
  USER_KEY,
} = require("../dist/providers/deepseek/session");

// Exactly the shapes the real profile had.
const REAL_TOKEN = JSON.stringify({
  value: "3Ffe+ET9ANgoI8Q0WlG9XocluDa2qfVBFVbUBZu2xSbbWFjjFaf5GVU7PRGIQolU",
  __version: "0",
});
const REAL_USER = JSON.stringify({ value: { id: "9a4c1ea5-5d62-41dc-8369-1389e58f0722" }, __version: "0" });

test("a real signed-in profile is recognised", () => {
  assert.equal(isSignedIn({ [TOKEN_KEY]: REAL_TOKEN }), true);
});

test("no token at all is signed out", () => {
  assert.equal(isSignedIn({}), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: undefined }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: null }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "" }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "   " }), false);
});

test("the key existing with an empty value is signed out", () => {
  // What signing out leaves behind: the wrapper stays, the token does not.
  assert.equal(isSignedIn({ [TOKEN_KEY]: JSON.stringify({ value: "", __version: "0" }) }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: JSON.stringify({ __version: "0" }) }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: JSON.stringify({ value: null }) }), false);
});

test("anything unreadable is treated as signed out", () => {
  // Being wrong this way costs one more sign-in. Being wrong the other way
  // costs a run that fails on its first send, after the user thinks they are
  // set up.
  assert.equal(isSignedIn({ [TOKEN_KEY]: "{not json" }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "{}" }), false);
});

test("a bare token, should the shape ever change, still counts", () => {
  // Defensive: the wrapper is DeepSeek's choice today, not a promise.
  assert.equal(isSignedIn({ [TOKEN_KEY]: "3Ffe+ET9ANgoI8Q0WlG9XocluDa2qfVBFVbUBZu2xSbb" }), true);
  // But a short scrap is not a token.
  assert.equal(isSignedIn({ [TOKEN_KEY]: "abc" }), false);
});

test("the account id is read for display, and missing is not an error", () => {
  assert.equal(accountId({ [USER_KEY]: REAL_USER }), "9a4c1ea5-5d62-41dc-8369-1389e58f0722");
  assert.equal(accountId({}), null);
  assert.equal(accountId({ [USER_KEY]: "{broken" }), null);
  assert.equal(accountId({ [USER_KEY]: JSON.stringify({ value: {} }) }), null);
});

test("the sign-in wall is told from the chat", () => {
  assert.equal(isSignInPage("https://chat.deepseek.com/sign_in"), true);
  assert.equal(isSignInPage("https://chat.deepseek.com/sign_in?from=x"), true);
  assert.equal(isSignInPage("https://chat.deepseek.com/"), false);
  assert.equal(isSignInPage(""), false);
});

test("DeepSeek's profile is its own, never ChatGPT's", () => {
  // ChatGPT's is ~/.onflip/browser-profile and must not be touched.
  const dir = deepseekProfileDir();
  assert.equal(dir, path.join(HOME, ".onflip", "providers", "deepseek", "browser-profile"));
  assert.notEqual(dir, path.join(HOME, ".onflip", "browser-profile"));
});
