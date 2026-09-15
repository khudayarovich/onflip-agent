"use strict";

/**
 * Whether OnFlip should report itself signed in, per service.
 *
 * From an external security audit of the shipped 0.10.31 build, which named
 * this as the most important application defect: the check answered yes
 * whenever a ChatGPT cookie or stored token existed, whatever service was
 * selected. Those say nothing about DeepSeek or Qwen — their sessions live in
 * their own browser profiles — so a signed-out Qwen was reported as signed in
 * because ChatGPT happened to have a session on the same machine.
 *
 * It is also the root of a day spent chasing confusing sign-in states: the
 * app said connected, the turn went to a page with no session, and the
 * failure arrived much later and blamed something else.
 *
 * The audit names the critical case explicitly, and it is the first test
 * below: DeepSeek selected, ChatGPT cookie present, DeepSeek signed out must
 * report signed out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { reportsSignedIn } = require("../dist/providers/signed-in");

const evidence = (over) => ({
  signedOut: false,
  browserProvider: false,
  hasCookies: false,
  hasStoredToken: false,
  probe: null,
  ...over,
});

test("a browser service signed out, with a ChatGPT cookie present, is signed out", () => {
  // The audit's critical regression case, word for word.
  assert.equal(
    reportsSignedIn(evidence({ browserProvider: true, hasCookies: true, probe: false })),
    false
  );
});

test("nor does a stored ChatGPT token vouch for one", () => {
  assert.equal(
    reportsSignedIn(evidence({ browserProvider: true, hasStoredToken: true, probe: false })),
    false
  );
});

test("a browser service is signed in when its own probe says so, and only then", () => {
  assert.equal(reportsSignedIn(evidence({ browserProvider: true, probe: true })), true);
  assert.equal(reportsSignedIn(evidence({ browserProvider: true, probe: false })), false);
});

test("a probe that has not answered yet is not a yes", () => {
  // Null is an unknown, not a no — but it must not read as a yes either, or
  // the account bar claims a session before anything has looked for one.
  assert.equal(reportsSignedIn(evidence({ browserProvider: true, probe: null })), false);
  assert.equal(
    reportsSignedIn(evidence({ browserProvider: true, hasCookies: true, probe: null })),
    false,
    "and a ChatGPT cookie still does not fill the gap"
  );
});

test("ChatGPT keeps the evidence that is actually its own", () => {
  // The other direction matters just as much: this must not break the service
  // the credentials belong to.
  assert.equal(reportsSignedIn(evidence({ hasCookies: true })), true);
  assert.equal(reportsSignedIn(evidence({ hasStoredToken: true })), true);
  assert.equal(reportsSignedIn(evidence({ probe: true })), true);
  assert.equal(reportsSignedIn(evidence({})), false);
});

test("signing out in the app outranks every other signal", () => {
  assert.equal(
    reportsSignedIn(evidence({ signedOut: true, hasCookies: true, hasStoredToken: true, probe: true })),
    false
  );
  assert.equal(
    reportsSignedIn(evidence({ signedOut: true, browserProvider: true, probe: true })),
    false
  );
});
