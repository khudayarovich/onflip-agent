"use strict";

/**
 * A machine with no ChatGPT session is refused before anything is typed.
 *
 * Reported as "ChatGPT never finishes loading" (issue #1, 0.10.77, Windows
 * 11): a message sat on "Still working" with nothing coming back. Reproduced
 * here with the shipped engine and a config that had never signed in. The
 * start-up probe said "not signed in" at seven seconds, and the turn then
 * typed the whole 25,000-character prompt into ChatGPT's anonymous page and
 * waited 135 seconds for the silence guard to read the page. Two readers had
 * let it through: the anonymous page of October 2026 says "Log in to get
 * answers…" and never "Sign up", so the old wording check matched nothing;
 * and a profile with no stored jar fell through the recovery with a plain
 * return. The page's words are one pattern now, and the profile's own
 * session cookies decide when there are no words to go on.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANONYMOUS_WALL,
  looksSignedOut,
  anonymousPageRecovery,
} = require("../dist/chatgpt/browser-client");

// The page's text as `capturePageState` recorded it on 2026-10-16, from a
// profile that had never signed in, after a send that went nowhere.
const ANONYMOUS_2026 =
  "New chat Images Plugins Deep research See plans and pricing Help Settings Get responses tailored to you " +
  "Log in to get answers based on saved chats, plus create images and upload files. Log in ChatGPT ";

// The wall the pattern was first written for.
const WALL_2025 = "ChatGPT Log in Sign up Welcome back Log in Sign up for free";

test("the anonymous wall matches both wordings the page has used", () => {
  assert.ok(ANONYMOUS_WALL.test(ANONYMOUS_2026), "the October 2026 promo");
  assert.ok(ANONYMOUS_WALL.test(WALL_2025), "the 2025 wall");
});

test("a signed-in page is not anonymous by its words", () => {
  // A sidebar: account name, chats, the model pill — no "Log in" anywhere.
  const sidebar =
    "New chat Search chats Library Projects Chess game UI Dark squares blue Farrukh Yuldashev Free ChatGPT 5.6 Luna";
  assert.equal(ANONYMOUS_WALL.test(sidebar), false);
  // A reply about authentication says "log in" too. "Sign up" within reach
  // of it is what the 2025 shape needed; a sentence about a login page is
  // not that, and the new phrase is the promo's own words.
  const reply = "To fix the bug, make the Log in button redirect to /dashboard after the session cookie is set.";
  assert.equal(ANONYMOUS_WALL.test(reply), false);
});

test("the census reader shares the pattern, and chat history still overrides it", () => {
  assert.equal(looksSignedOut({ text: ANONYMOUS_2026, matches: { history: 0 } }), true);
  assert.equal(looksSignedOut({ text: WALL_2025, matches: { history: 0 } }), true);
  // A sidebar with chats in it is signed in whatever the words say.
  assert.equal(looksSignedOut({ text: ANONYMOUS_2026, matches: { history: 3 } }), false);
});

test("a live session is reloaded, never refused and never overwritten", () => {
  for (const stored of [0, 12]) {
    for (const spent of [false, true]) {
      assert.equal(
        anonymousPageRecovery({ sessionLive: true, profileSessionCookies: 0, storedCookies: stored, storedJarSpent: spent }),
        "reload"
      );
    }
  }
});

test("a stored jar is put back once, and refused as spent the second time", () => {
  assert.equal(
    anonymousPageRecovery({ sessionLive: false, profileSessionCookies: 0, storedCookies: 12, storedJarSpent: false }),
    "inject"
  );
  assert.equal(
    anonymousPageRecovery({ sessionLive: false, profileSessionCookies: 0, storedCookies: 12, storedJarSpent: true }),
    "jar-spent"
  );
});

test("no jar and no session cookie in the profile is refused before anything is typed", () => {
  assert.equal(
    anonymousPageRecovery({ sessionLive: false, profileSessionCookies: 0, storedCookies: 0, storedJarSpent: false }),
    "no-session"
  );
});

test("words alone do not refuse a profile that still holds a session", () => {
  // The look can be a moment's rendering; with a token in the profile and
  // nothing stored to compare, the send decides and a silence reads the page.
  assert.equal(
    anonymousPageRecovery({ sessionLive: false, profileSessionCookies: 2, storedCookies: 0, storedJarSpent: false }),
    "proceed"
  );
  // Unreadable cookies count as a session, as they do for injection.
  assert.equal(
    anonymousPageRecovery({ sessionLive: false, profileSessionCookies: -1, storedCookies: 0, storedJarSpent: false }),
    "proceed"
  );
});

test("the in-page anonymous check carries the shared pattern with its backslashes intact", () => {
  // The program is built from the regex's own printing, so `\b` arrives as
  // `\b` and not as a stray `b`. Run the same text through a copy of what
  // the page receives.
  const program =
    `(() => { var text = ${JSON.stringify(ANONYMOUS_2026)}; ` +
    `var wall = ${ANONYMOUS_WALL.toString()}.test(text); return wall; })()`;
  assert.equal(new Function(`return ${program}`)(), true);
});
