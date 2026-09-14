"use strict";

/**
 * A sentence written for a person should not be parsed by a machine.
 *
 * Found in a week of this machine's own session logs: six `turn failed`
 * errors, four of them the same one, every one of them ending the turn. The
 * report that found them concluded the retry wrapper was not recovering. It
 * was not retrying at all.
 *
 * `classifyFailure` reads a failure's code when it has one and falls back to
 * reading its English sentence when it does not, and nothing in the DeepSeek
 * driver set a code. So this sentence —
 *
 *     "DeepSeek did not start answering. The page may have signed out, or
 *      the send did not land."
 *
 * — was classified on the word "signed out" inside its own hedge, came back
 * fatal, and `sendWithRetry` threw before its first attempt. The case the
 * hedge names second, which is the common one and the one a retry fixes, was
 * the case that could never be retried.
 *
 * Playwright's "is interrupted by another navigation" went the same way, on
 * the word "Interrupted" — a pattern that is in the fatal list to honour a
 * user pressing stop. A page racing itself is the opposite of that.
 *
 * backoff.ts documents two earlier outbreaks of this in its own comments.
 * These are the third and fourth. The driver now says what a failure is
 * instead of describing it and hoping.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { classifyFailure } = require("../dist/chatgpt/backoff");

const DRIVER = path.join(__dirname, "..", "src", "providers", "deepseek", "browser.ts");
const source = fs.readFileSync(DRIVER, "utf8");

/** The exact strings, from the logs, that ended those turns. */
const HEDGED = "DeepSeek did not start answering. The page may have signed out, or the send did not land.";
const RACED = 'page.goto: Navigation to "chat.deepseek.com/" is interrupted by another navigation';

test("the messages that ended those turns really do read as fatal", () => {
  // Pinned, because this is the whole reason the codes exist. Neither of
  // these is a sign-out and neither is a user pressing stop; both were read
  // as one, and a fatal classification skips the retry loop entirely.
  assert.equal(classifyFailure(HEDGED).kind, "fatal");
  assert.equal(classifyFailure(RACED).kind, "fatal");
});

test("with a code, both are retried instead", () => {
  assert.equal(classifyFailure(HEDGED, "send-not-landed").kind, "retry");
  assert.equal(classifyFailure(RACED, "send-not-landed").kind, "retry");
});

test("a profile that really is signed out stays fatal", () => {
  // The discrimination is the point. Retrying a signed-out profile costs
  // three ninety-second silences and cannot succeed; the driver now reads
  // the session out of the page rather than writing "may have" into a
  // string for something else to parse.
  const message =
    "The browser profile is signed out of DeepSeek, so the message went nowhere. " +
    "Sign in from the account menu, then send again.";
  assert.equal(classifyFailure(message, "signed-out").kind, "fatal");
});

test("a stop the user asked for is still honoured", () => {
  assert.equal(classifyFailure("interrupted", "interrupted").kind, "fatal");
});

test("every failure the driver throws carries its own type", () => {
  // The structural rule, so the next failure added here cannot go back to
  // being classified by its prose. One of them is deliberately uncoded — a
  // reply-budget timeout, which both drivers have always retried — but it
  // is the same type as the rest, so giving it a code is a one-line change
  // rather than a rediscovery of this bug.
  const throws = source.split("\n").filter((line) => line.includes("throw new "));
  assert.ok(throws.length >= 5, `expected the driver to throw; found ${throws.length}`);
  for (const line of throws) {
    assert.ok(
      line.includes("throw new DeepSeekError"),
      `a raw Error is classified by its sentence — ${line.trim()}`
    );
  }
});

test("the hedge is gone from the driver itself", () => {
  // The sentence that started this cannot come back: it is not merely
  // mis-classified, it is a message that does not know what it is reporting.
  // Comments excluded: the sentence is quoted at the top of the driver as
  // the reason the codes exist, and that quotation should stay.
  const code = source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  assert.ok(
    !code.includes("may have signed out"),
    "the driver is guessing in prose again"
  );
});
