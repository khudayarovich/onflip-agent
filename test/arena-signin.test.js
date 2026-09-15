"use strict";

/**
 * The Arena sign-in window that closed while Google was still asking.
 *
 * Reported from a Mac, twice. First: press Sign in, a fresh Chrome opens
 * every time and nothing is remembered. That was a wait keyed to a window
 * close that macOS does not deliver, and 0.10.42 fixed it by watching the
 * profile for the account cookie instead. Then: the window now closes by
 * itself, in the middle of the Google sign-in, and afterwards there is no
 * account — so the next press opens a fresh browser again, which is the
 * first report wearing the second bug's face.
 *
 * The accelerator asked "is there a cookie called arena-auth-prod-v*?" and
 * a comment beside it asserted that a cookie is unambiguous. Every part of
 * that is wrong, and the order of writes on a live sign-in says why:
 *
 *   Log In pressed           arena-auth-prod-v1
 *   Continue with Google     arena-auth-prod-v1-code-verifier
 *   ...nothing, for as long as the person takes to type a password...
 *   the session lands        arena-auth-prod-v1.0, arena-auth-prod-v1.1
 *
 * So the name arrives two steps before the account does, and then holds
 * perfectly still - which also defeated the first attempt at a fix, a rule
 * that waited for a new record to stop changing. And SQLite keeps the bytes
 * of rows it deletes, so a profile that has been through one failed attempt
 * answers yes on the very first poll with no account in it at all.
 *
 * What separates them is the chunk suffix: Supabase splits a cookie it
 * cannot fit in one, and only a real session JWT is that big.
 *
 * Qwen's sign-in had already made this mistake, in its own file, with the
 * lesson written at the top of it. These tests hold the corrected rule —
 * has a session APPEARED, and has it stopped changing — so the third time
 * costs a test run rather than a release.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasNewAccount, newAccountSettled } = require("../dist/providers/arena/signin");

test("a record that was already there is not a sign-in", () => {
  // The shipped bug, in one line. SQLite is holding the name from an earlier
  // attempt; the window opens; nothing has changed; the flow must keep
  // waiting for the person rather than closing the window on them.
  const before = new Set(["stale"]);
  assert.equal(hasNewAccount(before, new Set(["stale"])), false);
});

test("a record that appeared is", () => {
  assert.equal(hasNewAccount(new Set(["stale"]), new Set(["stale", "fresh"])), true);
});

test("and so is the first record on a profile that had none", () => {
  // The ordinary first sign-in, which must keep working exactly as before.
  assert.equal(hasNewAccount(new Set(), new Set(["fresh"])), true);
});

test("a deleted record left in the file beside a new one still counts", () => {
  // The cookie file is not compacted on write: after a real sign-in the old
  // bytes and the new record sit in the same file, and a scan may well find
  // the stale one first. Comparing single values would miss this; comparing
  // sets does not.
  const before = new Set(["dead-a", "dead-b"]);
  assert.equal(hasNewAccount(before, new Set(["dead-a", "dead-b", "session"])), true);
});

test("nothing new is not a sign-in, however many records there are", () => {
  // The negative control for the one above: a busy profile that nobody has
  // signed in to must not read as success just because it is busy.
  const before = new Set(["dead-a", "dead-b", "dead-c"]);
  assert.equal(hasNewAccount(before, new Set(["dead-c", "dead-a", "dead-b"])), false);
});

test("a record that has only just appeared is not finished being written", () => {
  // The fault itself: `arena-auth-prod-v1.0` lands as the PKCE verifier goes
  // out, and the session comes back into `...v1.1` a moment later. Acting on
  // the first one closes the window mid-authentication, which is exactly
  // what the user saw.
  const seenAt = 1_000;
  const prints = new Set(["verifier"]);
  assert.equal(newAccountSettled(seenAt, prints, prints, seenAt + 500), false);
  assert.equal(newAccountSettled(seenAt, prints, prints, seenAt + 4_999), false);
});

test("a record that is still changing is not finished either", () => {
  // Long enough to have settled by the clock, but the second cookie has just
  // landed — so the round trip is still in flight and the window stays open.
  const seenAt = 1_000;
  assert.equal(
    newAccountSettled(seenAt, new Set(["verifier"]), new Set(["verifier", "session"]), seenAt + 9_000),
    false
  );
  // And the other direction: a record going away is movement too.
  assert.equal(
    newAccountSettled(seenAt, new Set(["verifier", "session"]), new Set(["session"]), seenAt + 9_000),
    false
  );
});

test("a record that has stood still for long enough is", () => {
  const seenAt = 1_000;
  const prints = new Set(["session"]);
  assert.equal(newAccountSettled(seenAt, prints, prints, seenAt + 5_000), true);
  assert.equal(newAccountSettled(seenAt, prints, prints, seenAt + 60_000), true);
});

test("a set that was never seen to change cannot settle", () => {
  // Guarding the zero: `newSeenAt` is 0 until something new appears, and a
  // clock value of 0 compares as "ages ago" against any real timestamp. If
  // that were allowed through, the first poll on any profile would settle
  // immediately — the original bug, rebuilt.
  const prints = new Set(["session"]);
  assert.equal(newAccountSettled(0, prints, prints, Date.now()), false);
});

test("the settle window is long enough to cover an OAuth round trip", () => {
  // Not an arbitrary number: it has to outlast the gap between the two
  // writes, and stay shorter than anybody's patience. A test rather than a
  // comment because it is the one number that decides whether the window
  // closes on somebody mid-sign-in.
  const seenAt = 1_000;
  const prints = new Set(["session"]);
  assert.equal(newAccountSettled(seenAt, prints, prints, seenAt + 3_000), false, "3s is too eager");
  assert.equal(newAccountSettled(seenAt, prints, prints, seenAt + 5_000), true, "5s is enough");
});

test("a real profile's fingerprints hold still between reads", () => {
  // The rule above only works if reading the same file twice gives the same
  // answer. That is not free: the fingerprint is 220 bytes taken from the
  // cookie's name onward, and if a last-accessed timestamp fell inside that
  // window it would churn on every write, nothing would ever settle, and the
  // accelerator would quietly never fire again.
  //
  // Skipped where there is no profile — CI has none — and run against the
  // real one anywhere a person has signed in, which is where it matters.
  const { authCookiePrints } = require("../dist/providers/arena/signin");
  const { arenaProfileDir } = require("../dist/providers/arena/session");
  const dir = arenaProfileDir();
  const prints = authCookiePrints(dir);
  if (prints.size === 0) return; // no profile here; nothing to hold still
  assert.deepEqual(
    [...authCookiePrints(dir)].sort(),
    [...prints].sort(),
    "the same file read twice gave two different answers"
  );
  // And the corollary, stated as the thing the flow actually asks: a profile
  // nobody is signing in to must not look like a sign-in.
  assert.equal(hasNewAccount(prints, authCookiePrints(dir)), false);
});

/**
 * The byte shapes, as they actually appear in the file.
 *
 * Chrome stores no delimiter after a cookie's name — the encrypted value
 * begins immediately with its own `v10` marker — so these are the strings a
 * scan really sees. Taken from a live profile rather than imagined, which
 * matters: the version digits and that `v10` are exactly what a rule written
 * from memory gets wrong.
 */
const ON_DISK = {
  pending: "arena-auth-prod-v1v10\x8f\x1a",
  verifier: "arena-auth-prod-v1-code-verifierv10\x2b",
  chunk0: "arena-auth-prod-v1.0v10\x44\x9c",
  chunk1: "arena-auth-prod-v1.1v10\xa7\x03",
  // And the form the index entries take, with no value after the name.
  bare0: "arena-auth-prod-v1.0\x0c\x02\x09",
};

test("the cookies of a sign-in in progress are not a session", () => {
  // The fault, stated in the terms the scan works in. Both of these are on
  // disk while somebody is at Google's password box, and neither may start
  // the clock that closes their window.
  const { authCookieNames } = require("../dist/providers/arena/signin");
  assert.deepEqual(authCookieNames(Buffer.from(ON_DISK.pending, "latin1")), []);
  assert.deepEqual(authCookieNames(Buffer.from(ON_DISK.verifier, "latin1")), []);
});

test("a chunked session is", () => {
  const { authCookieNames } = require("../dist/providers/arena/signin");
  assert.equal(authCookieNames(Buffer.from(ON_DISK.chunk0, "latin1")).length, 1);
  assert.equal(authCookieNames(Buffer.from(ON_DISK.chunk1, "latin1")).length, 1);
  assert.equal(authCookieNames(Buffer.from(ON_DISK.bare0, "latin1")).length, 1);
});

test("a whole sign-in, in the order the bytes arrive", () => {
  // The three states the poll loop walks through, end to end: an empty
  // profile, a sign-in under way, and an account. Only the last one may
  // count — this is the test that fails if the prefix rule ever comes back.
  const { authCookieNames } = require("../dist/providers/arena/signin");
  const empty = Buffer.from("provisional_user_idv10", "latin1");
  const inFlight = Buffer.from(ON_DISK.pending + ON_DISK.verifier, "latin1");
  const done = Buffer.from(ON_DISK.pending + ON_DISK.chunk0 + ON_DISK.chunk1, "latin1");
  assert.deepEqual(authCookieNames(empty), []);
  assert.deepEqual(authCookieNames(inFlight), [], "the window must stay open here");
  assert.equal(authCookieNames(done).length, 2, "and close here");
});
