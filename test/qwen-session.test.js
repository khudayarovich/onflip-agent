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

test("a guest conversation is the session being gone, whatever the token says", () => {
  // The one that cost four releases, and it was in the URL the whole time.
  //
  // Reproduced locally at last: three turns answered, then every turn sat at
  // /c/guest with nothing generating and no reply, until the silence window
  // blamed the send. Qwen puts a visitor whose session has lapsed into a
  // guest conversation, and a send from there is never answered — measured on
  // the very first probe of this service, before the driver existed.
  //
  // The token cannot see it. Qwen leaves an expired JWT in localStorage at
  // full length and correct shape, so `isSignedIn` says yes, the account bar
  // says connected, and every turn goes somewhere that will never answer.
  const { sessionStateFrom } = require("../dist/providers/qwen/browser");
  const { isGuestChat } = require("../dist/providers/qwen/session");
  const stale = { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln" };

  assert.equal(isGuestChat("https://chat.qwen.ai/c/guest"), true);
  assert.equal(isGuestChat("https://chat.qwen.ai/c/42744914-ad9b-44cb-8b7f-ddd783e2c6b9"), false);
  assert.equal(isGuestChat("https://chat.qwen.ai/"), false);

  // The address outranks the token, which is the whole point.
  assert.equal(sessionStateFrom("https://chat.qwen.ai/c/guest", stale), "absent");
  assert.equal(
    sessionStateFrom("https://chat.qwen.ai/c/42744914-ad9b-44cb-8b7f-ddd783e2c6b9", stale),
    "present"
  );
});

test("a guest chat id is never mistaken for a conversation", () => {
  // `guest` in the id slot must not be adopted as a thread to append to, or
  // the next turn would resume a conversation that cannot answer.
  assert.equal(conversationIdFrom("https://chat.qwen.ai/c/guest"), null);
});

test("a token whose own expiry has passed is not a session", () => {
  // From an external security audit, and from a day of this exact failure.
  // Qwen leaves an expired token in localStorage at full length and correct
  // shape; the check looked only at the shape, the app reported itself
  // connected, and the first message went to a guest chat and was never
  // answered. The expiry was sitting inside the token the whole time.
  //
  // This is an early rejection, not a verification: a token can be unexpired
  // and still revoked, and only Qwen can settle that. It settles the one case
  // that can be settled locally, before anything is sent.
  const { isExpiredToken } = require("../dist/providers/qwen/session");
  const make = (payload) =>
    ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  const hourAway = Math.floor(Date.now() / 1000) + 3600;

  assert.equal(isExpiredToken(make({ exp: hourAgo })), true);
  assert.equal(isExpiredToken(make({ exp: hourAway })), false);
  assert.equal(isSignedIn({ [TOKEN_KEY]: make({ exp: hourAgo }) }), false, "and it is not a session");
  assert.equal(isSignedIn({ [TOKEN_KEY]: make({ exp: hourAway }) }), true);
});

test("a token about to expire is refused a minute early", () => {
  // Clocks disagree, and a token that dies mid-turn costs a whole exchange.
  const { isExpiredToken } = require("../dist/providers/qwen/session");
  const make = (exp) =>
    ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");
  assert.equal(isExpiredToken(make(Math.floor(Date.now() / 1000) + 30)), true);
  assert.equal(isExpiredToken(make(Math.floor(Date.now() / 1000) + 300)), false);
});

test("a token this cannot read is left for the page to judge", () => {
  // Unreadable is not expired. Turning one unfamiliar format into "you are
  // signed out" would be the same mistake in the other direction.
  const { isExpiredToken } = require("../dist/providers/qwen/session");
  assert.equal(isExpiredToken("not.a.jwt"), false);
  assert.equal(isExpiredToken("eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.sig"), false);
  assert.equal(isExpiredToken(""), false);
  // No `exp` claim at all: nothing to judge, so nothing is claimed.
  const noExp = ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url"), "sig"].join(".");
  assert.equal(isExpiredToken(noExp), false);
});

// ---------------------------------------------------------------------------
// What the page says, versus what the token says
// ---------------------------------------------------------------------------

const { isUsableChatUrl, sessionStateFrom } = require("../dist/providers/qwen/browser");

test("the page's own sign-in header outranks a token that looks fine", () => {
  // The fault six releases missed, measured on a real profile rather than
  // reasoned about: a token 209 characters long, correctly shaped, with its
  // own expiry twenty-nine days away - and the page rendering the Log in /
  // Sign up pair, structurally identical to a profile created seconds
  // earlier that had never seen Qwen. The service had dropped the session;
  // nothing readable offline could tell.
  //
  // So the app reported itself connected, every message went into a guest
  // conversation that is never answered, and the person was told to sign in
  // to an account the app insisted was already signed in.
  const live = { token: jwt, userRole: "user" };

  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, true), "absent");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, false), "present");
});

test("only a sighting counts; nobody looking is not evidence of anything", () => {
  // `undefined` is "nobody asked" and `false` is "the header had not
  // rendered yet". Reading either as signed out would refuse a working
  // session on a slow machine, which is the same fault in the other
  // direction - and that direction is the one that costs a sign-in.
  const live = { token: jwt, userRole: "user" };

  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, undefined), "present");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live), "present");
});

test("and it cannot rescue a page that was never readable", () => {
  // Off-origin stays "unreadable" whatever the header appears to say: a page
  // mid-navigation has neither Qwen's storage nor Qwen's header, and
  // answering "signed out" there is the original bug this file guards.
  assert.equal(sessionStateFrom("about:blank", null, true), "unreadable");
  assert.equal(sessionStateFrom("https://example.com/", { token: jwt }, true), "unreadable");
});

test("a guest conversation and the sign-in wall are addresses to leave, not to use", () => {
  // Both start with the chat URL, which is why the old rule - "anywhere
  // under chat.qwen.ai is where we belong" - made them fixed points the
  // driver could never navigate out of. This machine's own log has the
  // consequence: a turn landed in a guest conversation, the next turn
  // opened "the page", got the same guest page back, and sent into it
  // again.
  assert.equal(isUsableChatUrl("https://chat.qwen.ai/c/guest"), false);
  assert.equal(isUsableChatUrl("https://chat.qwen.ai/auth"), false);
  assert.equal(isUsableChatUrl("https://chat.qwen.ai/auth?next=/"), false);
});

test("but a real conversation is left exactly where it is", () => {
  // Navigating away from these would start a new chat on every turn, which
  // is a worse bug than the one being fixed.
  assert.equal(isUsableChatUrl("https://chat.qwen.ai/"), true);
  assert.equal(isUsableChatUrl("https://chat.qwen.ai/c/2f1e8a44-0b6d-4c31-9a77-5e0c1d8b2a93"), true);
  assert.equal(isUsableChatUrl("https://chat.qwen.ai/?model=qwen3-plus"), true);
});

test("and anywhere off Qwen is somewhere to navigate back from", () => {
  assert.equal(isUsableChatUrl("about:blank"), false);
  assert.equal(isUsableChatUrl(""), false);
  assert.equal(isUsableChatUrl("https://example.com/"), false);
});

test("the recovery asks before spending its second attempt", () => {
  // Source-level, because this lives inside the turn loop and there is no
  // harness that can drive one. What it pins: after reloading out of a guest
  // conversation, the driver checks the page's own header before sending
  // again. Without it the recovery re-sends blind, lands in a second guest
  // conversation, and only reports the session gone after another silence
  // window - which is the ninety seconds people were waiting through.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "providers", "qwen", "browser.ts"),
    "utf8"
  );
  const recovery = source.slice(source.indexOf("const recoverAndResend"));
  const body = recovery.slice(0, recovery.indexOf("await submit();"));

  assert.match(body, /await pageShowsAuthPrompt\(page\)/);
  assert.match(body, /"signed-out"/);
});
