"use strict";

/**
 * What the app says when it cannot import a session from a browser.
 *
 * The message was accurate and useless. A user reported being unable to
 * connect ChatGPT at all: Chrome would not give up a cookie, Firefox would,
 * and the browser sign-in was refused — three dead ends, none of which said
 * which door was still open. The diagnosis was never the missing part; the
 * next move was.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { describeReport } = require("../dist/auth/extract");

const found = (browser, outcome, detail) => ({ browser, outcome, detail });

test("app-bound encryption is explained as by-design, and points at the way in", () => {
  // Chrome 127 and later. Reported as a bare failure it reads as OnFlip being
  // broken, and the one thing that does work goes unmentioned.
  const text = describeReport([found("Chrome", "app-bound"), found("Edge", "app-bound")]);

  assert.match(text, /only Chrome can read them/);
  assert.match(text, /not a fault OnFlip can fix/);
  assert.match(text, /Sign in to ChatGPT/);
});

test("but not when something closer to hand would fix it", () => {
  // A locked browser is one the user can just close. Telling them to abandon
  // the import when it is one click from working would be wrong.
  const text = describeReport([found("Chrome", "app-bound"), found("Firefox", "locked")]);

  assert.match(text, /Firefox is open/);
  assert.doesNotMatch(text, /not a fault OnFlip can fix/);
});

test("a browser with no session is not a reason to keep trying to import", () => {
  // Nothing to close and nothing to grant here, so the advice still stands.
  const text = describeReport([found("Chrome", "app-bound"), found("Firefox", "no-session")]);

  assert.match(text, /Firefox has no ChatGPT session/);
  assert.match(text, /Sign in to ChatGPT/);
});

test("no browsers at all says so plainly", () => {
  assert.equal(describeReport([]), "No supported browser was found on this machine.");
});

test("an unreadable browser reports why", () => {
  const text = describeReport([found("Chrome", "error", "database is locked")]);
  assert.match(text, /database is locked/);
});
