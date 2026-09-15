"use strict";

/**
 * The sign-in loop, and the assumption that caused it.
 *
 * Reported from a Mac: press Sign in, Chrome opens and closes again before
 * anything can be typed, the app says it is signed in, the next message goes
 * nowhere, and it asks to sign in again. Round and round.
 *
 * The sign-in flow had an accelerator that closed the window as soon as a
 * token appeared in the profile on disk, so that somebody who had finished
 * signing in did not have to press a button as well. It asked "is there a
 * token?", and the comment beside it asserted that a signed-out profile has
 * none.
 *
 * That assumption is false, and the same day's work is what disproved it:
 * Qwen leaves an expired token in localStorage at full length and correct
 * shape. So on any profile whose session had lapsed the answer was yes the
 * instant the window opened — verified against the real profile, which
 * matched at offset 4710 of 000004.log with nobody having signed in at all.
 * The window closed, the flow read that same stale token, and reported
 * success to somebody who had never got the chance to type.
 *
 * The question worth asking is whether a token has APPEARED. These tests
 * hold that rule against the shapes a real Local Storage log produces.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasNewToken } = require("../dist/providers/qwen/signin");

const print = (s) => s;

test("a token that was already there is not a sign-in", () => {
  // The loop, in one line. The profile holds a stale token; the window opens;
  // nothing has changed; the flow must keep waiting for the person.
  const before = new Set([print("stale")]);
  assert.equal(hasNewToken(before, new Set([print("stale")])), false);
});

test("a token that appeared is", () => {
  assert.equal(hasNewToken(new Set(["stale"]), new Set(["stale", "fresh"])), true);
});

test("and so is the first token on a profile that had none", () => {
  // The ordinary first sign-in, which must keep working exactly as before.
  assert.equal(hasNewToken(new Set(), new Set(["fresh"])), true);
});

test("an append-only log keeping both records still counts as a sign-in", () => {
  // Chrome's Local Storage log is append-only: after a fresh sign-in the old
  // record and the new one sit in the same file, and the first match found by
  // a scan may well be the stale one. Comparing single values would have
  // missed this; comparing sets does not.
  assert.equal(hasNewToken(new Set(["stale"]), new Set(["stale", "fresh"])), true);
});

test("a profile that went quiet is not a sign-in either", () => {
  // Compaction can move a record out of the .log and into a compressed block
  // a byte scan cannot see, so the set can shrink without anybody signing in
  // or out. Nothing new has appeared, so nothing is claimed.
  assert.equal(hasNewToken(new Set(["stale"]), new Set()), false);
  assert.equal(hasNewToken(new Set(), new Set()), false);
});

test("closing the window without signing in is not a sign-in", () => {
  // The second door into the same loop, and the one a fix to the accelerator
  // alone would have left open.
  //
  // The verification step asks whether the profile holds a well-formed token,
  // and a lapsed Qwen session leaves exactly that behind. So cancelling, or
  // closing the window, or signing in and failing, all came back "signed in"
  // on the strength of the token that was already there — and the next
  // message went to a guest chat and started the loop again.
  //
  // The rule is deliberately narrow: it refuses only when the profile ALREADY
  // held a token and no new one arrived. That case cannot be a sign-in.
  const { isRealSignIn } = require("../dist/providers/qwen/signin");
  const call = (pageSaysSignedIn, hadTokenBefore, newTokenAppeared) =>
    isRealSignIn({ pageSaysSignedIn, hadTokenBefore, newTokenAppeared });

  // The loop: a stale token, nothing new, and a shape check that says yes.
  assert.equal(call(true, true, false), false);
  // A real sign-in over the top of an expired one.
  assert.equal(call(true, true, true), true);
  // A first sign-in on an empty profile is left to the page check, so it
  // still works even if compaction hides the write from the byte scan.
  assert.equal(call(true, false, false), true);
  // And nothing is ever claimed when the profile itself says no.
  assert.equal(call(false, false, true), false);
  assert.equal(call(false, true, true), false);
});
