"use strict";

/**
 * A ChatGPT session signed in by the person stays the session.
 *
 * Reported from a Mac as ChatGPT "asking me auth again and again even after
 * I signed in — I send a message and it asks a sign-in again", and from a
 * second Windows PC as a first send that "never appeared in the conversation".
 * Neither reproduced on this project's machine, and the machines' logs were
 * not to hand, so this closes the ways a freshly signed-in session could be
 * undone or disbelieved, each of which the code allowed:
 *
 * - Every start read the ChatGPT session out of the person's everyday browser
 *   (Firefox, Safari, Chrome where readable) and kept it as the stored jar —
 *   after a sign-in whose whole promise was that OnFlip's own profile is the
 *   session from then on. Seen on this project's test machine: a Free account
 *   signed in, and the account label naming the account Firefox held.
 * - Whenever a page merely looked signed out, the recovery paths wrote that
 *   jar over the live session, and the send paths told the person to sign in —
 *   on the page's look alone, never asking ChatGPT whether the session was
 *   in fact fine.
 * - A launch still under way when the sign-in freed the profile came up
 *   afterwards on it, and the start-up checks could launch during a sign-in.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-session-owner-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_STREAM_HOOK = "0";
delete process.env.ONFLIP_SESSION_TOKEN;
delete process.env.CHATGPT_SESSION_TOKEN;
delete process.env.ONFLIP_PROVIDER;

// A browser nobody arranged must fail the test, never start.
let launch = () => Promise.reject(new Error("a browser launch the test did not arrange"));
let launches = 0;
const playwrightKey = require.resolve("playwright");
require.cache[playwrightKey] = {
  id: playwrightKey,
  filename: playwrightKey,
  loaded: true,
  exports: {
    chromium: {
      launchPersistentContext: (...args) => {
        launches++;
        return launch(...args);
      },
      launch: () => Promise.reject(new Error("a browser launch the test did not arrange")),
    },
  },
};

const config = require("../dist/config");
const extract = require("../dist/auth/extract");
const access = require("../dist/auth/access");
const { resolveAuth } = require("../dist/auth/resolve");
const browser = require("../dist/chatgpt/browser-client");

const JAR = { name: "__Secure-next-auth.session-token", value: "f".repeat(64) };

test("once signed in through the window, other browsers are not read at start", async () => {
  let reads = 0;
  const real = { extract: extract.spawnExtractToken, fetch: access.fetchAccessToken };
  extract.spawnExtractToken = () => {
    reads++;
    return { cookies: [JAR], primary: JAR, deviceId: "d", source: "firefox" };
  };
  access.fetchAccessToken = async () => ({
    accessToken: "t",
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { name: "The account Firefox holds", email: "firefox@example.com" },
  });
  try {
    config.saveConfig({ sessionInProfile: true });
    const owned = await resolveAuth();
    assert.equal(reads, 0, "the everyday browser was read over a signed-in profile");
    assert.deepEqual(owned.cookies, []);
    assert.equal(config.loadConfig().accountName, undefined, "another account's name was put on the label");

    // Without it — nobody has signed in through the window — the old path
    // stands: the everyday browser is where a session can come from.
    config.saveConfig({ sessionInProfile: undefined });
    const imported = await resolveAuth();
    assert.equal(reads, 1);
    assert.equal(imported.cookies.length, 1);
  } finally {
    extract.spawnExtractToken = real.extract;
    access.fetchAccessToken = real.fetch;
    config.saveConfig({ sessionInProfile: undefined, accountName: undefined, accountEmail: undefined });
  }
});

/** A page whose session endpoint gives these answers in turn. */
function pageAnswering(...answers) {
  const asked = [];
  return {
    asked,
    evaluate: async () => {
      asked.push(Date.now());
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    waitForTimeout: async () => {},
  };
}

test("ChatGPT's own answer is asked before anyone is called signed out", async () => {
  // It answers empty for the first call or two while the app settles.
  assert.equal(await browser.sessionAnswers(pageAnswering(false, true)), true);
  const out = pageAnswering(false, false, false, true);
  assert.equal(await browser.sessionAnswers(out), false);
  assert.equal(out.asked.length, 3, "asked more than its three times");
  // A page that cannot answer at all is no evidence of a session.
  assert.equal(await browser.sessionAnswers(pageAnswering(new Error("closed"), new Error("closed"), new Error("closed"))), false);
});

test("the sign-in window holds OnFlip's own browser off the profile", async () => {
  launches = 0;
  browser.__setSigningInForTest(true);
  try {
    const state = await browser.checkSignedIn([]);
    assert.equal(state.reachable, false);
    assert.match(state.detail, /sign-in window is open/);
    assert.equal(launches, 0, "a browser was launched on the profile during a sign-in");
  } finally {
    browser.__setSigningInForTest(false);
  }
});

test("a close waits for a launch under way, and closes what it opened", { timeout: 10_000 }, async () => {
  const context = {
    closed: false,
    cookies: async () => [],
    addInitScript: async () => {},
    pages: () => [page],
    newPage: async () => page,
    on: () => {},
    close: async () => {
      context.closed = true;
    },
  };
  const page = {
    url: () => "about:blank",
    isClosed: () => context.closed,
    setDefaultTimeout: () => {},
    close: async () => {},
    goto: async () => {},
    evaluate: async () => null,
    waitForTimeout: async () => {},
    reload: async () => {},
  };
  let release;
  launch = () => new Promise((resolve) => (release = () => resolve(context)));
  launches = 0;
  browser.configureBrowser({ persistProfile: true });
  const checking = browser.checkSignedIn([]);
  await new Promise((r) => setImmediate(r));
  assert.equal(launches, 1);

  let closedAt = null;
  const closing = browser.closeBrowser().then(() => (closedAt = Date.now()));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closedAt, null, "the close did not wait for the launch under way");
  release();
  await closing;
  assert.equal(context.closed, true, "what the launch opened was left running on the profile");
  await Promise.race([checking, new Promise((r) => setTimeout(r, 3_000))]);
});
