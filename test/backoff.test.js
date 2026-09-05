"use strict";

/**
 * The failure taxonomy, and the regressions it exists to prevent.
 *
 * Every case below that names a date or a measurement is a real incident from
 * `~/.onflip/logs`, not an invented example. The point of the file is that
 * those incidents were all *classification* bugs — the code did the right
 * thing with the wrong verdict — and a classification bug is exactly the kind
 * a test can hold down forever at no runtime cost.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyFailure,
  failureCodeOf,
  isResumableFailure,
  serviceMessage,
  newChatGapMs,
  newChatsInWindow,
  paceNewChat,
  __resetPacingForTest,
} = require("../dist/chatgpt/backoff");

test("a code decides the verdict, and the sentence beside it does not", () => {
  // The whole point of the code: this message is full of words the regex
  // ladder treats as a throttle, and it is still classified as a retry.
  const withCode = classifyFailure(
    "rate limit — you have reached your limit, HTTP 429",
    "composer-refused"
  );
  assert.equal(withCode.kind, "retry");

  // The same sentence with no code falls back to the ladder and cools down.
  assert.equal(classifyFailure("rate limit — HTTP 429").kind, "cooldown");
});

test("a throttle code still honours a server-supplied retry-after", () => {
  const named = classifyFailure('retry-after: 42 seconds', "throttled");
  assert.equal(named.kind, "cooldown");
  assert.equal(named.seconds, 42);

  // Absurd values are clamped rather than trusted.
  assert.equal(classifyFailure("retry-after 99999", "throttled").seconds, 3600);

  // With no delay named, the code's own default applies.
  assert.equal(classifyFailure("too fast", "throttled").seconds, 5 * 60);
});

test("every code maps to a verdict", () => {
  const codes = [
    "unusual-activity",
    "throttled",
    "refused",
    "composer-refused",
    "composer-entry",
    "send-not-landed",
    "anonymous",
    "chat-lost",
    "signed-out",
    "service-error",
    "interrupted",
  ];
  for (const code of codes) {
    const verdict = classifyFailure("some message", code);
    assert.ok(
      ["retry", "fatal", "cooldown"].includes(verdict.kind),
      `${code} produced no usable verdict`
    );
  }
});

test("failureCodeOf reads a code off an error and ignores rubbish", () => {
  const e = Object.assign(new Error("x"), { code: "throttled" });
  assert.equal(failureCodeOf(e), "throttled");

  // Node's own errors carry codes like ENOENT that mean nothing here, and
  // treating one as a verdict would be worse than having no code at all.
  assert.equal(failureCodeOf(Object.assign(new Error("x"), { code: "ENOENT" })), undefined);
  assert.equal(failureCodeOf(new Error("plain")), undefined);
  assert.equal(failureCodeOf(null), undefined);
  assert.equal(failureCodeOf("a string"), undefined);
});

// ---------------------------------------------------------------------------
// the three historical misclassifications, as regressions
// ---------------------------------------------------------------------------

test("a composer stumble is not fatal, however its advice is worded", () => {
  // The original bug: the advice text ended "run `onflip login --headed`",
  // and the fatal test matched the word "login" — so the one failure that
  // most wants a retry was the one that never got it.
  const advice =
    "The message could not be entered into the ChatGPT composer (0 of 12 lines arrived). " +
    "Try signing in again with onflip login if it keeps happening.";
  assert.equal(classifyFailure(advice, "composer-entry").kind, "retry");
});

test("a refused send is not a throttle, however its advice is worded", () => {
  // The original bug: the message said "rate-limited", this function read
  // the message, and a composer that would not clear became a persisted
  // five-minute cooldown — three times in one evening.
  const advice =
    "The message was typed but ChatGPT would not accept it. ChatGPT may be rate-limiting this account.";
  assert.equal(classifyFailure(advice, "composer-refused").kind, "retry");
});

test("the real abuse check is a cooldown, in the wording it actually arrives with", () => {
  // A live 403 body. An earlier guard matched on "log in" and "rate limit",
  // neither of which appears here, so it was retried twice — two and four
  // seconds apart, which is the shape that deepens a block.
  const real = '{"detail":"Unusual activity has been detected from your device"}';
  const verdict = classifyFailure(real);
  assert.equal(verdict.kind, "cooldown");
  assert.ok(verdict.seconds >= 600, "the quiet period should be substantial");
});

// ---------------------------------------------------------------------------
// resumability
// ---------------------------------------------------------------------------

test("a signed-out session is never resumed automatically", () => {
  // Measured: 41 identical re-injections over seventeen minutes, because
  // every automatic "continue" opened another chat against a session the
  // server had stopped accepting. Only signing in fixes it.
  assert.equal(isResumableFailure("ChatGPT is signed out", "signed-out"), false);
});

test("an interruption is the user's decision and is not undone", () => {
  assert.equal(isResumableFailure("Interrupted", "interrupted"), false);
  assert.equal(isResumableFailure("Interrupted by the user"), false);
});

test("a cooldown is not resumed, but an ordinary transport failure is", () => {
  assert.equal(isResumableFailure("Waiting out a ChatGPT cooldown — 5 minutes left."), false);
  assert.equal(isResumableFailure("that chat stopped answering"), true);
  assert.equal(isResumableFailure("composer would not clear", "composer-refused"), true);
});

// ---------------------------------------------------------------------------
// service messages
// ---------------------------------------------------------------------------

test("ChatGPT's own error pages are attributed, not answered", () => {
  assert.ok(serviceMessage("Something went wrong"));
  assert.ok(serviceMessage("Internal Server Error"));
  assert.ok(serviceMessage("You've reached your limit for GPT-5.6 Sol"));
});

test("a long reply discussing an error is not mistaken for being one", () => {
  // The gate that keeps a real answer about error handling from being
  // relabelled as ChatGPT's own failure page.
  const essay =
    "Something went wrong is the message ChatGPT shows when a request fails. " +
    "x".repeat(500);
  assert.equal(serviceMessage(essay), null);
});

test("an ordinary answer is not a service message", () => {
  assert.equal(serviceMessage("I read the file and the bug is on line 42."), null);
  assert.equal(serviceMessage(""), null);
});

// ---------------------------------------------------------------------------
// new-chat pacing
// ---------------------------------------------------------------------------

test("new chats are paced, and the gap grows once the rate is unreasonable", async () => {
  __resetPacingForTest();
  assert.equal(newChatsInWindow(), 0);

  const base = newChatGapMs();
  assert.ok(base > 0, "there should always be some gap between conversations");

  // Ten is already past what a person does; the gap holds until then.
  for (let i = 0; i < 10; i++) await paceNewChat(abortedSignal());
  assert.equal(newChatsInWindow(), 10);
  assert.equal(newChatGapMs(), base);

  // Past the soft limit it climbs, which is what breaks a recovery loop.
  for (let i = 0; i < 5; i++) await paceNewChat(abortedSignal());
  assert.ok(
    newChatGapMs() > base,
    "the gap should widen once conversations are being opened in bursts"
  );

  __resetPacingForTest();
  assert.equal(newChatsInWindow(), 0);
});

test("pacing gives up its wait when the turn is aborted", async () => {
  __resetPacingForTest();
  await paceNewChat();
  // A second chat would normally wait seconds. An aborted signal must cut
  // that short, or stopping a run would hang for the length of the gap.
  const started = Date.now();
  await paceNewChat(abortedSignal());
  assert.ok(Date.now() - started < 1_000, "an aborted wait should return promptly");
  __resetPacingForTest();
});

/** An AbortSignal that is already aborted, so no test ever really sleeps. */
function abortedSignal() {
  const c = new AbortController();
  c.abort();
  return c.signal;
}
