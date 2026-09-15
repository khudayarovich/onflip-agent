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

test("a probe that looked and found nothing outranks a cookie still in the jar", () => {
  // Holding a cookie is not holding a session. The jar keeps what it was
  // given until something expires it, and a cookie the service has stopped
  // honouring looks exactly like one it still accepts.
  //
  // The engine already knew: a turn failing "signed-out" sets the probe to
  // false precisely so the app stops claiming a connection through every
  // failed turn. That intent was discarded one line later, because
  // `hasCookies` answered first and the probe never got a say - so on
  // ChatGPT the banner went on saying connected while every turn failed.
  assert.equal(
    reportsSignedIn({
      signedOut: false,
      browserProvider: false,
      hasCookies: true,
      hasStoredToken: true,
      probe: false,
    }),
    false
  );
});

test("but nobody having looked yet is not a verdict", () => {
  // `null` is the startup path: ChatGPT with cookies is reported ready
  // without probing at all, and turning "not asked" into "signed out" would
  // put a red banner over every launch until the first turn.
  assert.equal(
    reportsSignedIn({
      signedOut: false,
      browserProvider: false,
      hasCookies: true,
      hasStoredToken: false,
      probe: null,
    }),
    true
  );
});

test("and a probe that says yes still stands on its own", () => {
  assert.equal(
    reportsSignedIn({
      signedOut: false,
      browserProvider: false,
      hasCookies: false,
      hasStoredToken: false,
      probe: true,
    }),
    true
  );
});

// ---------------------------------------------------------------------------
// The background re-check, and when it is allowed to say anything
// ---------------------------------------------------------------------------

const { watchVerdict } = require("../dist/providers/signed-in");

test("a session that has ended while the app sat idle is reported", () => {
  // The case this exists for. A Qwen session was measured dying in about
  // three and a half hours with the app open, and the only way to find out
  // was to write a message, send it, wait, and be told afterwards.
  assert.equal(watchVerdict({ signedIn: false, reachable: true }, true), "signed-out");
});

test("and one that comes back is reported too", () => {
  // Signing in elsewhere, or a service that was briefly refusing. The banner
  // has to clear itself or it becomes a thing people learn to ignore.
  assert.equal(watchVerdict({ signedIn: true, reachable: true }, false), "signed-in");
});

test("a check that could not look changes nothing, ever", () => {
  // The direction that costs somebody a sign-in which cannot help: a slow
  // page read as a lapsed session. Unreachable is not a verdict, whatever
  // was believed before it.
  assert.equal(watchVerdict({ signedIn: false, reachable: false }, true), "ignore");
  assert.equal(watchVerdict({ signedIn: true, reachable: false }, false), "ignore");
  assert.equal(watchVerdict({ signedIn: false, reachable: false }, null), "ignore");
});

test("and an answer that agrees with the screen says nothing", () => {
  // Otherwise the app announces "still signed in" every few minutes.
  assert.equal(watchVerdict({ signedIn: true, reachable: true }, true), "ignore");
  assert.equal(watchVerdict({ signedIn: false, reachable: true }, false), "ignore");
});

test("the first definite answer counts, whichever way it goes", () => {
  // `null` is "nobody has looked yet", so the app is showing whatever it
  // assumed at startup — which is exactly when a real answer is worth having.
  assert.equal(watchVerdict({ signedIn: false, reachable: true }, null), "signed-out");
  assert.equal(watchVerdict({ signedIn: true, reachable: true }, null), "signed-in");
});
