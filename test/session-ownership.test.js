"use strict";

/**
 * Whose session wins: the browser profile's, or the stored jar's.
 *
 * The old answer was "always the jar", and it cost a seventeen-minute loop —
 * a run that had answered 161 turns was signed out mid-session because the
 * launch overwrote the profile's live session with an older import, and every
 * recovery then rewrote the same stale bytes. The rule is small enough to
 * state in four cases, and expensive enough to be worth stating them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldInjectStoredSession } = require("../dist/chatgpt/browser-client");

const decide = (state) =>
  shouldInjectStoredSession({
    storedCookies: 0,
    profileSessionCookies: 0,
    pending: false,
    ...state,
  });

test("a profile with its own session is never overwritten by a carried-over jar", () => {
  // The regression. resolveAuth reads Firefox on every start, so the jar is
  // non-empty on most machines; that is not a reason to clobber a session
  // the server has been rotating all afternoon.
  const d = decide({ storedCookies: 76, profileSessionCookies: 2 });
  assert.equal(d.inject, false);
  assert.match(d.why, /already holds a session/);
});

test("a profile with no session gets the stored jar, which is what it is for", () => {
  const d = decide({ storedCookies: 76, profileSessionCookies: 0 });
  assert.equal(d.inject, true);
  assert.equal(d.consumesPending, false);
});

test("an explicit sign-in or import beats whatever the profile holds", () => {
  // The user naming a session is not a guess, so this is the one case that
  // overwrites a profile that already has one — switching accounts depends
  // on it.
  const d = decide({ storedCookies: 40, profileSessionCookies: 2, pending: true });
  assert.equal(d.inject, true);
  assert.equal(d.consumesPending, true, "the pending flag must be cleared once applied");
});

test("nothing stored means nothing to inject, whatever the profile holds", () => {
  for (const profileSessionCookies of [0, 2, -1]) {
    const d = decide({ storedCookies: 0, profileSessionCookies, pending: true });
    assert.equal(d.inject, false);
  }
});

test("an unreadable profile is treated as having a session, not as having none", () => {
  // The safe direction: injecting over a profile that may well hold a good
  // session is the mistake this whole function exists to stop making.
  const d = decide({ storedCookies: 76, profileSessionCookies: -1 });
  assert.equal(d.inject, false);
  assert.match(d.why, /could not be read/);
});

test("an unreadable profile still yields to an explicit sign-in", () => {
  const d = decide({ storedCookies: 76, profileSessionCookies: -1, pending: true });
  assert.equal(d.inject, true);
  assert.equal(d.consumesPending, true);
});

test("every decision explains itself, because this ends up in a log", () => {
  const cases = [
    { storedCookies: 0, profileSessionCookies: 0 },
    { storedCookies: 5, profileSessionCookies: 0 },
    { storedCookies: 5, profileSessionCookies: 1 },
    { storedCookies: 5, profileSessionCookies: -1 },
    { storedCookies: 5, profileSessionCookies: 1, pending: true },
  ];
  for (const c of cases) {
    assert.ok(decide(c).why.length > 10, `no usable reason for ${JSON.stringify(c)}`);
  }
});
