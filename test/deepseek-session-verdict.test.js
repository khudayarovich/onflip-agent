"use strict";

/**
 * Asking DeepSeek whether the session is real, instead of assuming.
 *
 * DeepSeek's signed-in check read a token out of localStorage and stopped
 * there — the same fault Qwen shipped for six releases, where a token that
 * is present, well-formed and no longer honoured reads as a live session.
 * The app says connected, the sends fail, and the person is told to sign in
 * to an account it insists is fine.
 *
 * The difference here is that the answer was already being fetched. The
 * driver called `/api/v0/users/current` with the token to put a name in the
 * sidebar, and threw everything else away: a 401 returned the same empty
 * object as a timeout, so the one piece of ground truth available was
 * received and discarded.
 *
 * The rule below is what that answer means. The asymmetry is deliberate and
 * is the whole design: only the service refusing the credential counts as
 * signed out. Everything else that goes wrong is this code failing to find
 * out, and failing to find out must never cost somebody a sign-in.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { sessionVerdict } = require("../dist/providers/deepseek/browser");

test("the service refusing the token is the one answer that means signed out", () => {
  assert.equal(sessionVerdict({ reached: true, status: 401, hasUser: false }), "dead");
  assert.equal(sessionVerdict({ reached: true, status: 403, hasUser: false }), "dead");
});

test("an account described back is a live session", () => {
  assert.equal(sessionVerdict({ reached: true, status: 200, hasUser: true }), "live");
});

test("a service having a bad day is not a verdict on your session", () => {
  // The failure that would otherwise sign people out during an outage.
  for (const status of [500, 502, 503, 504, 429, 418]) {
    assert.equal(sessionVerdict({ reached: true, status, hasUser: false }), "unknown", String(status));
  }
});

test("and neither is a request that never completed", () => {
  // Offline, DNS, a proxy, the eight-second timeout. Nobody asked, so
  // nobody may answer.
  assert.equal(sessionVerdict({ reached: false }), "unknown");
  assert.equal(sessionVerdict({ reached: false, status: 0 }), "unknown");
  assert.equal(sessionVerdict(null), "unknown");
  assert.equal(sessionVerdict(undefined), "unknown");
  assert.equal(sessionVerdict({}), "unknown");
});

test("a 200 that describes nobody is not proof of a session either", () => {
  // The shape changing under us must not be read as a live account. It is
  // the same "could not find out" as any other surprise.
  assert.equal(sessionVerdict({ reached: true, status: 200, hasUser: false }), "unknown");
});

test("no token to ask with is signed out, not unknown", () => {
  // Reached the point of asking and there was no credential at all. That is
  // an empty store by another name, and the existing check already calls
  // that signed out.
  assert.equal(sessionVerdict({ reached: true, status: 0, hasUser: false }), "dead");
});
