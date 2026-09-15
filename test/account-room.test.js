"use strict";

/**
 * Whose name goes in whose room.
 *
 * `accountName` and `accountEmail` are filed per service, because both
 * services have an account and neither should see the other's. But they were
 * being written from one place that cannot know whose they are:
 * `resolveAuth` asks ChatGPT's session endpoint for an access token, and that
 * response names a ChatGPT account whoever happens to be running.
 *
 * So on a DeepSeek or Qwen run the name went into that service's room, and
 * the sidebar showed a ChatGPT identity over a session that had never been
 * signed in to. Found on the first Qwen launch — the account bar read a real
 * name and email above a red banner saying the app was not signed in — and
 * `providers.deepseek` turned out to have been holding the same two values,
 * from the same line, since DeepSeek shipped.
 *
 * This is the regression test for the rule that fixes it: the account is
 * recorded only when ChatGPT is the service running. The session keys are
 * not affected and are checked here too, because they travel in the same
 * write and must keep going to ChatGPT's room whoever is running.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-acct-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// A token by hand, so resolveAuth does not go looking through real browsers.
process.env.ONFLIP_SESSION_TOKEN = "a-session-token-long-enough-to-pass";
delete process.env.ONFLIP_PROVIDER;

const CONFIG = path.join(HOME, ".onflip", "config.json");
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
const read = () => JSON.parse(fs.readFileSync(CONFIG, "utf8"));

// ChatGPT's session endpoint, answering the way it does for a signed-in
// account. Replaced on the module's exports because that is how the compiled
// caller reaches it.
const access = require("../dist/auth/access");
access.fetchAccessToken = async () => ({
  accessToken: "an-access-token",
  expires: new Date(Date.now() + 3_600_000).toISOString(),
  user: { name: "A ChatGPT Person", email: "person@example.com" },
});

const { resolveAuth } = require("../dist/auth/resolve");

test("on ChatGPT, the account it names is kept", async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: "chatgpt" }));
  process.env.ONFLIP_PROVIDER = "chatgpt";
  await resolveAuth();
  const stored = read();
  assert.equal(stored.accountName, "A ChatGPT Person");
  assert.equal(stored.accountEmail, "person@example.com");
});

test("on Qwen, ChatGPT's account is not written into Qwen's room", async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: "qwen" }));
  process.env.ONFLIP_PROVIDER = "qwen";
  await resolveAuth();
  const stored = read();
  const room = stored.providers?.qwen ?? {};
  assert.equal(room.accountName, undefined, "a name nobody signed in with");
  assert.equal(room.accountEmail, undefined);
});

test("nor into DeepSeek's", async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: "deepseek" }));
  process.env.ONFLIP_PROVIDER = "deepseek";
  await resolveAuth();
  const room = read().providers?.deepseek ?? {};
  assert.equal(room.accountName, undefined);
  assert.equal(room.accountEmail, undefined);
});

test("and the top level does not pick it up sideways either", async () => {
  // The other half of the same mistake: refusing to write it into the room
  // but writing it at the top level instead would put a ChatGPT name where
  // ChatGPT reads it — correct by luck here, and wrong the moment the name
  // came from somewhere else. It is simply not written.
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: "qwen" }));
  process.env.ONFLIP_PROVIDER = "qwen";
  await resolveAuth();
  const stored = read();
  assert.equal(stored.accountName, undefined);
  assert.equal(stored.accountEmail, undefined);
});

test("the session still goes to ChatGPT's room whoever is running", async () => {
  // It travels in the same write, and it is ChatGPT's by declaration: a
  // `__Secure-next-auth` cookie and the token it buys come from one place.
  // Filing it by the active provider is what once put a whole ChatGPT
  // session inside `providers.deepseek` and read it back as "connected".
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: "qwen" }));
  process.env.ONFLIP_PROVIDER = "qwen";
  await resolveAuth();
  const stored = read();
  assert.equal(stored.accessToken, "an-access-token", "at the top level, which is ChatGPT's room");
  assert.equal(stored.providers?.qwen?.accessToken, undefined, "never in another service's room");
});

test("a name identical to ChatGPT's is not read back on another service", async () => {
  // The residue half of the same bug. Every install that ran DeepSeek or Qwen
  // before the fix still has a real ChatGPT name and email filed in that
  // service's room, and stopping new writes does nothing about the ones
  // already there.
  //
  // It cannot be left to correct itself either. DeepSeek's page names the
  // account, so its next turn would overwrite it — but Qwen's page carries no
  // name and no email at all (measured on the live page), so `pageSessionUser`
  // answers null, the identify step returns early, and the wrong name would
  // stay on a Qwen account bar permanently.
  const { loadConfig } = require("../dist/config");
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({
      provider: "qwen",
      accountName: "A ChatGPT Person",
      accountEmail: "person@example.com",
      providers: {
        qwen: { accountName: "A ChatGPT Person", accountEmail: "person@example.com" },
      },
    })
  );
  process.env.ONFLIP_PROVIDER = "qwen";
  const cfg = loadConfig();
  assert.equal(cfg.accountName, undefined, "the bar falls back to 'Qwen account'");
  assert.equal(cfg.accountEmail, undefined);
});

test("but a name the service really reported is kept", async () => {
  // The rule has to be narrow enough to leave a genuine account alone —
  // otherwise it would blank the account bar of anyone who had signed in
  // properly, which is a worse bug than the one being fixed.
  const { loadConfig } = require("../dist/config");
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({
      provider: "deepseek",
      accountName: "A ChatGPT Person",
      accountEmail: "person@example.com",
      providers: { deepseek: { accountName: "fas*****98@gmail.com" } },
    })
  );
  process.env.ONFLIP_PROVIDER = "deepseek";
  const cfg = loadConfig();
  assert.equal(cfg.accountName, "fas*****98@gmail.com");
});

test("and ChatGPT's own room is never touched by the rule", async () => {
  const { loadConfig } = require("../dist/config");
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({ provider: "chatgpt", accountName: "A ChatGPT Person", accountEmail: "person@example.com" })
  );
  process.env.ONFLIP_PROVIDER = "chatgpt";
  const cfg = loadConfig();
  assert.equal(cfg.accountName, "A ChatGPT Person", "the top level is ChatGPT's room");
  assert.equal(cfg.accountEmail, "person@example.com");
});
