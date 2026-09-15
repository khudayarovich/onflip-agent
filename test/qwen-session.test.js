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

test("the service's own answer outranks a token that looks fine", () => {
  // The fault six releases missed, measured rather than reasoned about: a
  // token 209 characters long, correctly shaped, with its own expiry
  // twenty-nine days away - and `/api/v1/auths/` answering 401, in words:
  // "Your session has expired, or the token is no longer valid."
  //
  // Nothing readable offline could tell. So the app reported itself
  // connected, every message went into a guest conversation that is never
  // answered, and the person was told to sign in to an account the app
  // insisted was already signed in.
  const live = { token: jwt, userRole: "user" };

  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, "dead"), "absent");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, "live"), "present");
});

test("a session the service confirms is present even with nothing in the store", () => {
  // The service is the authority. If it says the credential is good, an
  // empty or unreadable store is this code's problem, not the person's.
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", {}, "live"), "present");
});

test("nobody having found out falls back to the token, never to signed out", () => {
  // `unknown` is an outage, a timeout, a shape that changed. It must behave
  // exactly as this function did before the service was ever asked -
  // anything else turns a bad network into a sign-in prompt.
  const live = { token: jwt, userRole: "user" };

  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, "unknown"), "present");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live, undefined), "present");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", live), "present");
  assert.equal(sessionStateFrom("https://chat.qwen.ai/", {}, "unknown"), "absent");
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

  assert.match(body, /await askQwen\(page\)\) === "dead"/);
  assert.match(body, /"signed-out"/);
});

test("an aborted navigation is a race, not a browser that went nowhere", () => {
  // From a real failure on a user's machine: the recovery navigated to the
  // chat root, Chromium answered `net::ERR_ABORTED`, and the error rose as
  // though nothing had loaded. It is the same event as "interrupted by
  // another navigation" wearing Chromium's wording - something else
  // navigated mid-flight - and on a single-page app that something else is
  // usually the app's own router, so the page very often did arrive.
  //
  // It matters here more than anywhere because the recovery fires within
  // half a second of a send, which is precisely when Qwen's router is
  // moving the page to the new conversation.
  const { isNavigationRace } = require("../dist/providers/qwen/browser");

  assert.equal(isNavigationRace("page.goto: net::ERR_ABORTED at https://chat.qwen.ai/"), true);
  assert.equal(isNavigationRace("navigation interrupted by another navigation"), true);
});

test("and a real navigation failure is still a real one", () => {
  // Widening this to "any goto failure might be fine" would swallow a DNS
  // failure, a refused connection and a timeout - each of which means the
  // page genuinely is not there, and each of which needs to be reported.
  const { isNavigationRace } = require("../dist/providers/qwen/browser");

  for (const real of [
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://chat.qwen.ai/",
    "page.goto: net::ERR_CONNECTION_REFUSED",
    "page.goto: Timeout 60000ms exceeded",
    "page.goto: net::ERR_INTERNET_DISCONNECTED",
    "Target page, context or browser has been closed",
  ]) {
    assert.equal(isNavigationRace(real), false, real);
  }
});

// ---------------------------------------------------------------------------
// Asking the service, and what its answer means
// ---------------------------------------------------------------------------

const { qwenSessionVerdict } = require("../dist/providers/qwen/browser");

test("the service refusing the token is the one answer that means signed out", () => {
  // Measured: 401 with {"error":"Your session has expired, or the token is
  // no longer valid. Please sign in again to proceed."}
  assert.equal(qwenSessionVerdict({ reached: true, status: 401 }), "dead");
  assert.equal(qwenSessionVerdict({ reached: true, status: 403 }), "dead");
});

test("and accepting it is a live session", () => {
  assert.equal(qwenSessionVerdict({ reached: true, status: 200 }), "live");
  assert.equal(qwenSessionVerdict({ reached: true, status: 204 }), "live");
});

test("a service having a bad day is not a verdict on your session", () => {
  // The failure that would otherwise sign people out during an outage.
  for (const status of [500, 502, 503, 504, 429, 418]) {
    assert.equal(qwenSessionVerdict({ reached: true, status }), "unknown", String(status));
  }
});

test("and neither is a request that never completed", () => {
  assert.equal(qwenSessionVerdict({ reached: false }), "unknown");
  assert.equal(qwenSessionVerdict(null), "unknown");
  assert.equal(qwenSessionVerdict(undefined), "unknown");
  assert.equal(qwenSessionVerdict({}), "unknown");
});

test("no token to ask with is signed out, not unknown", () => {
  assert.equal(qwenSessionVerdict({ reached: true, status: 0 }), "dead");
});

test("the driver no longer decides anything from the page's header", () => {
  // The 0.10.33 fix, and the reason it had to go. Measured on a real load:
  // the Log in button became visible at 1815ms and the 401 that decides what
  // the header should say arrived at 2561ms - three quarters of a second
  // later. So a genuinely signed-in profile renders Log in on every load,
  // briefly, and a check looking in that window told somebody who had just
  // signed in that they were signed out. Signing in again raced the same
  // way. That is the sign-in loop, shipped by the release meant to end it.
  //
  // A request has no such race, so the header must not be consulted at all -
  // leaving it in as a tie-breaker would leave the race in.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "providers", "qwen", "browser.ts"),
    "utf8"
  );

  assert.ok(
    !/header-right-auth-button/.test(source),
    "the racy header selector is back in the driver"
  );
  assert.match(source, /\/api\/v1\/auths\//);
});

// ---------------------------------------------------------------------------
// A page that claims to be working, and how long that is worth believing
// ---------------------------------------------------------------------------

const { thinkingStillCredible } = require("../dist/providers/qwen/browser");

test("a model thinking before it writes is waited for", () => {
  // The reason this signal exists at all: reply text is what the silence
  // clock watches, and thinking produces none. Without it a model that
  // thinks for more than ninety seconds is reported as a send that never
  // landed.
  assert.equal(thinkingStillCredible(true, false, 60_000), true);
});

test("and once it writes, it is simply answering", () => {
  // Text arriving makes the question moot, however long it has been.
  assert.equal(thinkingStillCredible(true, true, 10 * 60_000), true);
});

test("but a Stop button with nothing behind it stops holding the clock", () => {
  // "Generating" means one thing: Qwen's Stop control is on the page. It is
  // also a piece of UI that gets left behind — by an interrupted answer most
  // of all — and a stale one is indistinguishable from deep thought while
  // saying so for ever.
  //
  // That is what froze every turn after a sub-agent was stopped: the claim
  // reset the silence clock on each poll, so the silence window could never
  // fire and the turn ran to the full reply timeout.
  assert.equal(thinkingStillCredible(true, false, 151_000), false);
  assert.equal(thinkingStillCredible(true, false, 10 * 60_000), false);
});

test("a page that is not claiming anything never holds it", () => {
  assert.equal(thinkingStillCredible(false, false, 1_000), false);
  assert.equal(thinkingStillCredible(false, true, 1_000), false);
});

test("the limit is a parameter, because the right one is a judgement", () => {
  assert.equal(thinkingStillCredible(true, false, 5_000, 1_000), false);
  assert.equal(thinkingStillCredible(true, false, 5_000, 10_000), true);
});

test("a turn never begins behind the previous answer", () => {
  // Source-level: this lives inside sendTurn, which needs a browser. What it
  // pins is that the page is settled before the send — the page is shared
  // between turns and with any sub-agent, so an interrupted answer's Stop
  // control is still there when the next message goes.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "providers", "qwen", "browser.ts"),
    "utf8"
  );
  const send = source.slice(source.indexOf("export async function sendTurn("));
  const setup = send.slice(0, send.indexOf("const submit = async"));

  assert.match(setup, /await settlePage\(page\);/);
  // And stopping is checked rather than assumed: the click can land on a
  // control Qwen disabled with a CSS class and do nothing at all.
  assert.match(source, /async function stopGenerating\(page: Page\): Promise<boolean>/);
  assert.match(source, /if \(!\(await isGenerating\(page\)\)\) return/);
});

test("the silence window depends on whether the page's progress can be read", () => {
  // The fault behind most of this driver's history. `generating` came from
  // `button[aria-label="Stop"]` - an English string - and the page it runs
  // against is lang="ru-RU" with Russian labels. So the signal was never
  // seen, thinking looked exactly like silence, and every answer that took
  // more than ninety seconds to begin was reported as a send that did not
  // land while Qwen was writing it.
  //
  // Where the signal cannot be read, the window has to be long enough to
  // cover a model thinking. Where it can, ninety seconds is honest.
  const { silenceWindowMs } = require("../dist/providers/qwen/browser");

  assert.equal(silenceWindowMs(true, 90_000, 240_000), 90_000);
  assert.equal(silenceWindowMs(false, 90_000, 240_000), 240_000);
});

test("the stop control is matched by class and by more than one language", () => {
  // Measured on the real page: lang="ru-RU", labels "Новый чат", "Прокрутить
  // вниз", "Выбрать режим". A selector naming only the English word matches
  // nothing there, on every turn, for ever.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "providers", "qwen", "browser.ts"),
    "utf8"
  );
  const decl = source.slice(source.indexOf("const STOP_BUTTON = ["));
  const list = decl.slice(0, decl.indexOf("].join"));

  // A class is not translated, so it comes first.
  assert.match(list, /button\.stop-button/);
  assert.match(list, /aria-label="Stop"/);
  assert.match(list, /aria-label\^="Стоп"/);
  // Prefix matching, so "Стоп генерации" is caught by "Стоп".
  assert.ok(list.includes('^='), "localised labels must be prefix matches");
});

test("no question to the page is left unbounded", () => {
  // `.catch()` handles a call that rejects, not one that never returns, and
  // `$$eval` runs script in the page with no timeout of its own. Two of
  // these sit inside the poll loop, where one wedged renderer stops the loop
  // running and the turn deadline is never tested again.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "providers", "qwen", "browser.ts"),
    "utf8"
  );

  // Only the calls that run script in the page. `click`, `waitForSelector`
  // and friends carry Playwright's own timeout and are not the problem.
  const lines = source.split(String.fromCharCode(10));
  const unbounded = [];
  lines.forEach((line, i) => {
    if (!/\.(\$\$eval|\$eval|evaluate)\(/.test(line)) return;
    if (/^\s*\*/.test(line)) return; // a comment mentioning one
    const near = lines.slice(Math.max(0, i - 4), i + 1).join(" ");
    if (!/withTimeout/.test(near)) unbounded.push(`${i + 1}: ${line.trim().slice(0, 70)}`);
  });
  assert.deepEqual(unbounded, [], `unbounded page calls:\n${unbounded.join("\n")}`);
});
