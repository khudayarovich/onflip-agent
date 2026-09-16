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
  ARENA_SIGN_IN_ARGS,
  arenaSignInArgs,
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

test("the automation flag is not optional for the driver", () => {
  // Without it Arena accepts the text, enables the send button, and then
  // posts nothing at all — no error, no request, nothing in the log.
  // Measured both ways: headless refused, headless with this landed in 1.5s.
  assert.ok(
    ARENA_LAUNCH_ARGS.includes("--disable-blink-features=AutomationControlled"),
    "the driver will hang on every turn without this"
  );
});

test("and it is forbidden in the window a person signs in through", () => {
  // The exact opposite requirement, on the same profile, which is why these
  // are two lists rather than one with a spread.
  //
  // Google refuses OAuth from a browser it can tell is automated, so the
  // sign-in is a plain Chrome started the way a person starts one. Arena's
  // spread the driver's args because they were there, and Chrome said so in
  // a yellow bar: "You are using an unsupported command-line flag". Reported
  // as a sign-in that never took and a fresh browser every time.
  for (const arg of ARENA_SIGN_IN_ARGS) {
    assert.ok(
      !/automation|webdriver|blink-features|remote-debugging|headless/i.test(arg),
      `the sign-in window must not be told it is automated, but got ${arg}`
    );
  }
});

test("the sign-in window is still an ordinary Chrome in the ways that matter", () => {
  // The flags a person's browser wants, kept: no first-run wizard and no
  // fight about the default browser. Dropping the automation flag must not
  // quietly drop these too.
  assert.ok(ARENA_SIGN_IN_ARGS.includes("--no-first-run"));
  assert.ok(ARENA_SIGN_IN_ARGS.includes("--no-default-browser-check"));
});

test("no provider's sign-in borrows its driver's flags", () => {
  // The general form of the bug, held across all three browser providers so
  // the next one added cannot repeat it. DeepSeek's and Qwen's spell their
  // flags out inline; this reads the source rather than the values, because
  // what went wrong was a spread, not a string.
  const fs = require("node:fs");
  const path = require("node:path");
  for (const provider of ["arena", "deepseek", "qwen"]) {
    const file = path.join(__dirname, "..", "src", "providers", provider, "signin.ts");
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    assert.ok(
      !/LAUNCH_ARGS/.test(src),
      `${provider}'s sign-in spreads its driver's launch args; those carry automation flags`
    );
    assert.ok(
      !/blink-features|--headless|remote-debugging/.test(src),
      `${provider}'s sign-in passes an automation flag to a window a person signs in through`
    );
  }
});

test("the sign-in browser encrypts the profile the way the driver reads it", () => {
  // Arena's session lives in cookies, and cookie values are encrypted with
  // a key that depends on how the browser was started. Playwright launches
  // the driver with --use-mock-keychain (macOS) and --password-store=basic
  // (Linux); a sign-in browser started without them writes a session the
  // driver cannot decrypt one cookie of — and Chromium DROPS what it cannot
  // decrypt, so the account reads as absent and the profile is purged back
  // and forth between the two keys. Reported as a fresh browser on every
  // attempt, and only on macOS, because Windows keys cookies through DPAPI
  // the same way for both launches.
  assert.ok(
    arenaSignInArgs("darwin").includes("--use-mock-keychain"),
    "a Mac sign-in must share the driver's mock keychain"
  );
  assert.ok(
    arenaSignInArgs("linux").includes("--password-store=basic"),
    "a Linux sign-in must share the driver's basic password store"
  );
  // Windows needs neither: the key rides inside the profile.
  const win = arenaSignInArgs("win32");
  assert.ok(!win.includes("--use-mock-keychain"));
  assert.ok(!win.includes("--password-store=basic"));
  // And on every platform the base flags stay and nothing automation-shaped
  // sneaks back in.
  for (const platform of ["darwin", "linux", "win32"]) {
    const args = arenaSignInArgs(platform);
    assert.ok(args.includes("--no-first-run"), platform);
    assert.ok(args.includes("--no-default-browser-check"), platform);
    for (const a of args) {
      assert.ok(!/automation|webdriver|blink-features|remote-debugging|headless/i.test(a), a);
    }
  }
});

test("Playwright still forces the keystore flags this mirrors", () => {
  // The rule above mirrors two of Playwright's own default switches. If a
  // Playwright upgrade renames or drops either, the mirror goes stale and
  // the macOS sign-in silently breaks again — so the assumption is held
  // against the installed package, not against memory.
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "node_modules", "playwright-core");
  let src = "";
  for (const f of ["lib/coreBundle.js", "lib/server/chromium/chromiumSwitches.js"]) {
    try {
      src += fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      /* bundled differently in this version; the other file carries it */
    }
  }
  assert.ok(src.length > 0, "playwright-core not found where expected");
  assert.ok(src.includes("--use-mock-keychain"), "Playwright no longer mocks the macOS keychain");
  assert.ok(src.includes("--password-store=basic"), "Playwright no longer forces the basic store");
});
