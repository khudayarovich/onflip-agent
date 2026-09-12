"use strict";

/**
 * Why an automatic update did not start.
 *
 * Reported as "why does the update button open GitHub instead of updating?".
 * It does install in place on both Windows and macOS — but when a pre-flight
 * check fails it falls back to the download page, and it used to do that in
 * silence, which reads as the feature not existing.
 *
 * Worse, all three ways of not starting answered "no installable build for
 * this platform", and only one of them was that. The check re-runs at click
 * time against api.github.com unauthenticated — 60 requests an hour per
 * address, shared with the poll on a timer — so the likeliest reason is a
 * failed request, not an unsupported platform. Told the wrong one, someone
 * goes looking for a missing artifact that is sitting right there.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { whyNotInstallable } = require(path.join(__dirname, "..", "dist", "electron", "updates.js"));

const INSTALLABLE = { url: "https://example.invalid/a.zip", name: "a.zip" };

test("a check that could not run says so, and quotes the failure", () => {
  const why = whyNotInstallable({ error: "HTTP 403", available: false });
  assert.match(why, /update check failed/);
  assert.match(why, /403/, "the actual failure is carried through");
  assert.doesNotMatch(why, /platform/, "and it is not blamed on the platform");
});

test("rate limiting is the common case and must not read as unsupported", () => {
  // The one that sent this question: 60 requests an hour, shared with the
  // timer, and a 403 that looks like nothing in particular.
  const why = whyNotInstallable({ error: "HTTP 403 rate limit exceeded", available: false });
  assert.match(why, /rate limit/);
  assert.doesNotMatch(why, /no build|no installable/);
});

test("already up to date is its own answer", () => {
  assert.equal(whyNotInstallable({ available: false }), "no newer release was found");
});

test("a platform with no artifact is named precisely", () => {
  const why = whyNotInstallable({ available: true, installable: undefined }, "linux", "x64");
  assert.match(why, /linux\/x64/, "says which platform, so it can be checked against the release");
});

test("nothing in the way returns null, and the install proceeds", () => {
  assert.equal(whyNotInstallable({ available: true, installable: INSTALLABLE }), null);
});

test("an error outranks the other two", () => {
  // A failed check leaves `available` false and `installable` undefined, so
  // order decides which reason is reported — and the error is the true one.
  const why = whyNotInstallable({ error: "socket hang up", available: false, installable: undefined });
  assert.match(why, /socket hang up/);
});
