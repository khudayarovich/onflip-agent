"use strict";

/**
 * What counts as an Arena session, and where a turn may be sent from.
 *
 * Arena is the odd one of the four and every rule here turns on a
 * difference, so they are tested rather than assumed.
 *
 * Its session is a pair of cookies rather than a token in storage, and they
 * were measured expiring thirteen months out — against the roughly three and
 * a half hours a Qwen token lasted in practice. It also works signed out,
 * so "signed in" is the difference between an account and an anonymous
 * visitor, not between working and not working.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isSignedIn,
  isGuest,
  isUsableChatUrl,
  conversationIdFrom,
  ARENA_LAUNCH_ARGS,
} = require("../dist/providers/arena/session");

const ACCOUNT = [{ name: "arena-auth-prod-v1.0" }, { name: "arena-auth-prod-v1.1" }, { name: "_ga" }];
const VISITOR = [{ name: "provisional_user_id" }, { name: "cf_clearance" }, { name: "_ga" }];

test("an account's cookies are a session", () => {
  assert.equal(isSignedIn(ACCOUNT), true);
  // Either half alone still counts: they were observed set together, and
  // refusing a jar that has one would be a sign-out nobody asked for.
  assert.equal(isSignedIn([{ name: "arena-auth-prod-v1.0" }]), true);
});

test("a visitor's cookie is not a session, and is not nothing either", () => {
  // This is the distinction Arena has and the others do not. Reading the
  // guest cookie as a session is the mistake the naming exists to prevent.
  assert.equal(isSignedIn(VISITOR), false);
  assert.equal(isGuest(VISITOR), true);
});

test("an empty jar is neither", () => {
  for (const nothing of [[], null, undefined]) {
    assert.equal(isSignedIn(nothing), false);
    assert.equal(isGuest(nothing), false);
  }
});

test("and an account is never also a guest", () => {
  // A jar carrying both should not happen; if it ever did it would mean the
  // sign-in went wrong, and the account has to win.
  assert.equal(isGuest([...ACCOUNT, { name: "provisional_user_id" }]), false);
});

test("the pages with no composer are not places to send from", () => {
  // Qwen's driver paid for this twice: a `startsWith` test turns every
  // unusable page under the origin into a fixed point it can never leave.
  for (const dead of [
    "https://arena.ai/leaderboard",
    "https://arena.ai/leaderboard/agent",
    "https://arena.ai/history/search",
    "https://arena.ai/blog/agent-mode/",
    "https://arena.ai/terms-of-use",
    "https://arena.ai/login",
  ]) {
    assert.equal(isUsableChatUrl(dead), false, dead);
  }
});

test("but the chat and a conversation are", () => {
  assert.equal(isUsableChatUrl("https://arena.ai/"), true);
  assert.equal(isUsableChatUrl("https://arena.ai/c/01a0a6c5-4318-77ba-ba7e-627a65c837d2"), true);
});

test("and anywhere off Arena is not", () => {
  assert.equal(isUsableChatUrl("about:blank"), false);
  assert.equal(isUsableChatUrl("https://example.com/"), false);
  assert.equal(isUsableChatUrl(""), false);
});

test("a conversation id is read from the address", () => {
  assert.equal(
    conversationIdFrom("https://arena.ai/c/01a0a6c5-4318-77ba-ba7e-627a65c837d2"),
    "01a0a6c5-4318-77ba-ba7e-627a65c837d2"
  );
  assert.equal(conversationIdFrom("https://arena.ai/"), null);
});

test("the automation flag is not optional", () => {
  // Without it Arena accepts the text, enables the send button, and then
  // posts nothing at all — no error, no request, nothing in the log.
  // Measured both ways: headless refused, headless with this landed in 1.5s.
  assert.ok(
    ARENA_LAUNCH_ARGS.includes("--disable-blink-features=AutomationControlled"),
    "the driver will hang on every turn without this"
  );
});
