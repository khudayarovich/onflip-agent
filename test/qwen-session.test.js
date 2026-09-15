"use strict";

/**
 * What counts as a Qwen session, and what the page is saying when it refuses.
 *
 * Both halves exist because of the same failure. A guest who sends a message
 * to Qwen gets no reply and no error: a "Welcome to Qwen" modal appears over
 * the chat, the URL does not change, and the send simply goes nowhere.
 * Measured on the live page before any of this was written. Without the
 * rules below, that turn waits out the full ninety-second silence window and
 * then reports a send that did not land — when it landed perfectly well and
 * there was nobody signed in to answer it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isSignedIn,
  isSignInPage,
  conversationIdFrom,
  TOKEN_KEY,
} = require("../dist/providers/qwen/session");
const { matchServiceMessage, judgePageCensus, labelFor } = require("../dist/providers/qwen/browser");

/** A JWT's shape, which is all this ever needs to know about one. */
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

test("a bare JWT in `token` is a session", () => {
  // Read from a signed-in profile: localStorage `token`, three dot-separated
  // segments, no JSON wrapper around it.
  assert.equal(isSignedIn({ [TOKEN_KEY]: jwt }), true);
});

test("nothing there is not a session", () => {
  assert.equal(isSignedIn({}), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "" }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "   " }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: null }), false);
});

test("and neither is something that is not a token", () => {
  // The cost of being wrong this way is one extra sign-in. The cost the
  // other way is a run that fails on its first send.
  assert.equal(isSignedIn({ [TOKEN_KEY]: "not-a-jwt" }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "two.parts" }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: "a..c" }), false, "an empty segment is not a segment");
});

test("DeepSeek's wrapper shape is not read as a Qwen session", () => {
  // The two services store their sessions differently and the difference is
  // not cosmetic: DeepSeek wraps its token as `{"value":"…"}` and leaves the
  // key behind holding `{"value":null}` when signed out. A wrapper arriving
  // here is another service's shape, or a stale write, and reading it as a
  // token would call a signed-out profile signed in.
  assert.equal(isSignedIn({ [TOKEN_KEY]: '{"value":"' + jwt + '"}' }), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: '{"value":null}' }), false);
});

test("the sign-in wall is recognised by its address", () => {
  assert.equal(isSignInPage("https://chat.qwen.ai/auth"), true);
  assert.equal(isSignInPage("https://chat.qwen.ai/auth?from=chat"), true);
  assert.equal(isSignInPage("https://chat.qwen.ai/"), false);
  assert.equal(isSignInPage(""), false);
});

test("a conversation is the uuid in the path, and a fresh chat has none", () => {
  assert.equal(
    conversationIdFrom("https://chat.qwen.ai/c/42744914-ad9b-44cb-8b7f-ddd783e2c6b9"),
    "42744914-ad9b-44cb-8b7f-ddd783e2c6b9"
  );
  assert.equal(conversationIdFrom("https://chat.qwen.ai/"), null);
  assert.equal(conversationIdFrom(""), null);
});

test("the login modal is read as signed out, not as a send that failed", () => {
  // The real wording, from the live page.
  const said = matchServiceMessage(
    "Welcome to Qwen\nLog in to unlock features like video generation.\nLog in\nSign up"
  );
  assert.ok(said);
  assert.equal(said.code, "signed-out");
  assert.match(said.text, /Welcome to Qwen/);
});

test("a challenge is something a person clears, never something to retry into", () => {
  // Alibaba's risk control runs on this page. Retrying into a challenge is
  // how a session gets itself blocked properly.
  const said = matchServiceMessage("Just a moment...\nverify you are human");
  assert.ok(said);
  assert.equal(said.code, "refused");
});

test("being throttled and being broken are different answers", () => {
  assert.equal(matchServiceMessage("Too many requests").code, "throttled");
  assert.equal(matchServiceMessage("Server busy, please try again later.").code, "service-error");
  assert.equal(matchServiceMessage("请求过于频繁").code, "throttled", "the Chinese UI too");
});

test("an ordinary page says nothing", () => {
  assert.equal(matchServiceMessage("How can I help you?"), null);
  assert.equal(matchServiceMessage(""), null);
});

test("a missing send control is not drift — Qwen only mounts it when there is text", () => {
  // The regression that shipped for about an hour. Qwen mounts its send
  // control only once the composer has something in it: measured on the live
  // page, zero on an empty composer and one with a character typed. A census
  // runs against a page nobody is typing into, so asserting the control means
  // reporting "Qwen's page has changed: sending will fail" on every run while
  // sending works perfectly — which is precisely what happened on the first
  // real turn, in the same second as a reply that came back fine.
  //
  // So the send control is not in the contract at all, and this test is what
  // stops it being helpfully added back.
  const whole = { composer: 1, modelPicker: 1, newChat: 1 };
  assert.equal(judgePageCensus(whole).ok, true, "an empty composer is a healthy page");
  assert.equal(judgePageCensus({ ...whole, send: 0 }).ok, true, "and still is with send absent");
});

test("a page missing the composer is broken; a page missing the picker is not", () => {
  // The distinction is the point. A service that redesigns its page breaks
  // OnFlip silently — a click that finds nothing does nothing — and the
  // health panel is where that becomes visible. But "the model chooser
  // moved" costs a setting, and saying it costs every turn would be crying
  // wolf.
  const whole = { composer: 1, modelPicker: 1, newChat: 1 };
  assert.equal(judgePageCensus(whole).ok, true);

  const noComposer = judgePageCensus({ ...whole, composer: 0 });
  assert.equal(noComposer.ok, false);
  assert.match(noComposer.detail, /Sending will fail/);

  const noPicker = judgePageCensus({ ...whole, modelPicker: 0 });
  assert.equal(noPicker.ok, false);
  assert.match(noPicker.detail, /Turns will still work/);
});

test("a model slug maps to the label the picker shows", () => {
  // OnFlip's slug on one side, the words on the row the driver clicks on the
  // other. An unknown slug picks nothing rather than clicking something.
  assert.equal(labelFor("qwen3-plus"), "Qwen3.7-Plus");
  assert.equal(labelFor("qwen3-max"), "Qwen3.8-Max");
  assert.equal(labelFor("gpt-5"), "");
  assert.equal(labelFor(undefined), "");
});

test("a sign-in prompt is not proof of a signed-out profile", () => {
  // Reported from the field, on a Mac, repeatedly: turns failing with "the
  // browser profile is signed out of Qwen, so the message went nowhere",
  // where retrying often worked and signing in again always did.
  //
  // The cause was this rule. A match on the page's text went straight to
  // "signed out" without ever asking the token — the page is prose, the
  // token is the fact, and the prose was deciding. Qwen shows that wording
  // for a signed-out profile, for an expired session, and for a promo modal
  // offered to somebody perfectly signed in; only the first is worth sending
  // anyone to the sign-in button.
  //
  // This codebase has now learned the same lesson three times. backoff.ts
  // documents the first two.
  const { verdictForPrompt } = require("../dist/providers/qwen/browser");

  // Nothing in storage: genuinely signed out, whatever else is true.
  assert.equal(verdictForPrompt("absent", false), "signed-out");
  assert.equal(verdictForPrompt("absent", true), "signed-out");

  // A session and a prompt disagreeing. Reload once and send again rather
  // than making the user do it — which is exactly what "I retry and then it
  // works" was describing.
  assert.equal(verdictForPrompt("present", false), "reload");

  // Still there after a reload: the token has the shape of a live one and is
  // most likely expired. `isSignedIn` checks shape, and a stale JWT has the
  // same shape as a fresh one.
  assert.equal(verdictForPrompt("present", true), "expired");

  // Could not read the profile at all. Not a verdict, and never the one that
  // tells someone to fix a session that may be perfectly fine.
  assert.equal(verdictForPrompt("unreadable", false), "wait");
  assert.equal(verdictForPrompt("unreadable", true), "wait");
});

test("a page that is not on Qwen has no session to report, and never 'signed out'", () => {
  // The one that actually bit, reported twice from a Mac: turns failing with
  // "the browser profile is signed out of Qwen, so the message went nowhere"
  // on a profile that was signed in the whole time.
  //
  // localStorage belongs to an origin, not to a browser. A page on
  // about:blank, on an error page, or part-way through a navigation has its
  // own empty storage, and getItem there answers null WITHOUT THROWING - so
  // every guard that expected a throw let it past, and a perfectly good
  // session read as no session at all. A slower machine widens the window,
  // which is why it happened on a Mac and why retrying worked: the next
  // attempt found the page loaded.
  const { sessionStateFrom } = require("../dist/providers/qwen/browser");
  const live = { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln" };

  // On Qwen: a real verdict either way.
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live), "present");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/c/abc-123", live), "present");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", { token: null }), "absent");

  // Anywhere else: no verdict. These are the ones that were being read as a
  // signed-out profile.
  assert.equal(sessionStateFrom("about:blank", { token: null }), "unreadable");
  assert.equal(sessionStateFrom("chrome-error://chromewebdata/", { token: null }), "unreadable");
  assert.equal(sessionStateFrom("", { token: null }), "unreadable");
  assert.equal(sessionStateFrom("https://accounts.google.com/signin", { token: null }), "unreadable");

  // And a storage that could not be read at all is not an empty one.
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", null), "unreadable");
});
