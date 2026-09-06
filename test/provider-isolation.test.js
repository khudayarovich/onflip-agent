"use strict";

/**
 * That two services cannot reach into each other's settings.
 *
 * Reported within a minute of the first switch: DeepSeek's model picker
 * offered GPT-5.6 Luna and Sol, and the app said "connected" on an account
 * that had never been signed in to. Both had the same cause — one config file
 * holding one model, one plan and one session, read by whichever service
 * happened to be running.
 *
 * The fix gives each service a room of its own inside that file. ChatGPT
 * keeps the top level, exactly where every config written before providers
 * existed already put things, so an upgrade migrates nothing; anything else
 * reads and writes under `providers.<id>`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-iso-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_PROVIDER;
const CONFIG = path.join(HOME, ".onflip", "config.json");
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });

const write = (obj) => fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2));
const read = () => JSON.parse(fs.readFileSync(CONFIG, "utf8"));

const { loadConfig, saveConfig, clearConfigKeys } = require("../dist/config");
const { allModels, defaultModel } = require("../dist/models");

// What a real install looks like before any of this existed.
const EXISTING = {
  model: "gpt-5-6-mini",
  thinking: "high",
  planType: "prolite",
  sessionToken: "chatgpt-secret",
  accountEmail: "me@example.com",
  discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "" }],
  // App-wide, and shared on purpose.
  approvalMode: "ask",
  language: "ru",
};

// --- ChatGPT is exactly where it was ---------------------------------------

test("an install written before providers reads unchanged", () => {
  write(EXISTING);
  const c = loadConfig();
  assert.equal(c.model, "gpt-5-6-mini");
  assert.equal(c.planType, "prolite");
  assert.equal(c.sessionToken, "chatgpt-secret");
  assert.equal(c.approvalMode, "ask");
});

test("saving on ChatGPT still writes the top level, with no new nesting", () => {
  write(EXISTING);
  saveConfig({ model: "gpt-5-6" });
  const raw = read();
  assert.equal(raw.model, "gpt-5-6", "ChatGPT's model stays where it always was");
  assert.equal(raw.providers, undefined, "nothing is nested for ChatGPT");
});

// --- DeepSeek cannot see ChatGPT's ------------------------------------------

test("DeepSeek does not inherit ChatGPT's model, plan or session", () => {
  // The bleed itself: without scoping, every one of these came back.
  write({ ...EXISTING, provider: "deepseek" });
  const c = loadConfig();
  assert.equal(c.model, undefined, "no ChatGPT model");
  assert.equal(c.planType, undefined, "no ChatGPT plan");
  assert.equal(c.sessionToken, undefined, "no ChatGPT session — this is why it said connected");
  assert.equal(c.discoveredModels, undefined, "no ChatGPT model list");
  assert.equal(c.thinking, undefined);
});

test("but app-wide settings are still shared, because they describe the person", () => {
  write({ ...EXISTING, provider: "deepseek" });
  const c = loadConfig();
  assert.equal(c.approvalMode, "ask");
  assert.equal(c.language, "ru");
});

test("what DeepSeek saves lands in its own room, leaving ChatGPT's alone", () => {
  write({ ...EXISTING, provider: "deepseek" });
  saveConfig({ model: "deepseek-chat", planType: null, thinking: "off" });
  const raw = read();

  assert.equal(raw.providers.deepseek.model, "deepseek-chat");
  assert.equal(raw.providers.deepseek.thinking, "off");
  assert.equal(raw.model, "gpt-5-6-mini", "ChatGPT's model is untouched");
  assert.equal(raw.sessionToken, "chatgpt-secret", "and so is its session");
});

test("switching back to ChatGPT restores exactly what it had", () => {
  write({ ...EXISTING, provider: "deepseek" });
  saveConfig({ model: "deepseek-chat" });
  const raw = read();
  write({ ...raw, provider: "chatgpt" });

  const c = loadConfig();
  assert.equal(c.model, "gpt-5-6-mini");
  assert.equal(c.planType, "prolite");
  assert.equal(c.sessionToken, "chatgpt-secret");
});

test("an app-wide setting saved on DeepSeek is seen by ChatGPT too", () => {
  write({ ...EXISTING, provider: "deepseek" });
  saveConfig({ language: "en" });
  const raw = read();
  assert.equal(raw.language, "en", "shared settings stay shared");
  assert.equal(raw.providers?.deepseek?.language, undefined, "and are not duplicated");
});

// --- a session filed under the wrong service --------------------------------

test("ChatGPT's session is never written into another service's room", () => {
  // Found on a real install: the whole ChatGPT session — token, access token,
  // cookie name, account, discovered models — sitting inside
  // `providers.deepseek`, because a ChatGPT code path wrote it while DeepSeek
  // was the active service and the split filed it by who was running.
  write({ ...EXISTING, provider: "deepseek" });
  saveConfig({
    sessionToken: "fresh-chatgpt-secret",
    sessionCookieName: "__Secure-next-auth.session-token.0",
    accountEmail: "me@example.com",
    discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "" }],
  });
  const raw = read();
  assert.equal(raw.providers.deepseek.sessionToken, undefined, "not in DeepSeek's room");
  assert.equal(raw.providers.deepseek.accountEmail, undefined);
  assert.equal(raw.providers.deepseek.discoveredModels, undefined);
  assert.equal(raw.sessionToken, "fresh-chatgpt-secret", "filed where ChatGPT reads it");
});

test("and one an older version already misfiled is not read back", () => {
  // The symptom this caused: "connected" on an account never signed in to.
  write({
    ...EXISTING,
    provider: "deepseek",
    providers: { deepseek: { model: "deepseek-vision", sessionToken: "leaked", accountEmail: "me@example.com" } },
  });
  const c = loadConfig();
  assert.equal(c.sessionToken, undefined, "a stray copy is still not DeepSeek's session");
  assert.equal(c.accountEmail, undefined);
  assert.equal(c.model, "deepseek-vision", "its own settings still come through");
});

test("and the next save cleans it out of the file", () => {
  write({
    ...EXISTING,
    provider: "deepseek",
    providers: { deepseek: { model: "deepseek-vision", sessionToken: "leaked" } },
  });
  saveConfig({ thinking: "off" });
  assert.equal(read().providers.deepseek.sessionToken, undefined);
});

// --- clearing keys, which used to take the whole file with it ---------------

test("signing out of DeepSeek leaves ChatGPT signed in", () => {
  // `clearConfigKeys` wrote back what `loadConfig` returns — the two rooms
  // merged, with `providers` stripped off. On DeepSeek that deleted every
  // room in the file and left DeepSeek's own model and thinking sitting where
  // ChatGPT reads them, alongside a ChatGPT session that had just been wiped.
  write({ ...EXISTING, provider: "deepseek" });
  saveConfig({ model: "deepseek-vision", thinking: "off" });
  clearConfigKeys(["sessionToken", "accessToken", "accountEmail"]);

  const raw = read();
  assert.equal(raw.sessionToken, "chatgpt-secret", "ChatGPT's session survives");
  assert.equal(raw.model, "gpt-5-6-mini", "and its model");
  assert.ok(raw.providers?.deepseek, "DeepSeek's room is still there");
  assert.equal(raw.providers.deepseek.model, "deepseek-vision");
});

test("signing out of ChatGPT clears ChatGPT and nothing else", () => {
  write({ ...EXISTING, providers: { deepseek: { model: "deepseek-vision" } } });
  clearConfigKeys(["sessionToken", "accessToken"]);

  const raw = read();
  assert.equal(raw.sessionToken, undefined, "the session is gone");
  assert.equal(raw.model, "gpt-5-6-mini", "settings it was not asked to clear stay");
  assert.equal(raw.providers.deepseek.model, "deepseek-vision", "the other room is untouched");
});

test("signing out of one service does not sign the other out", () => {
  write({ ...EXISTING, provider: "deepseek" });
  saveConfig({ signedOut: true });
  const raw = read();
  assert.equal(raw.providers.deepseek.signedOut, true);
  assert.equal(raw.signedOut, undefined, "ChatGPT was not signed out");
});

// --- and the two symptoms that were reported --------------------------------

test("the model picker offers DeepSeek's own modes, not ChatGPT's models", () => {
  // Instant, Expert and Vision — the radio group above DeepSeek's composer,
  // which is the nearest thing it has to a model list. An earlier version of
  // this test expected a single "deepseek-chat" entry, which was my reading
  // of the page before seeing the modes.
  write({ ...EXISTING, provider: "deepseek" });
  const slugs = allModels().map((m) => m.slug);
  assert.deepEqual(slugs, ["deepseek-instant", "deepseek-expert", "deepseek-vision"]);
  assert.equal(defaultModel(), "deepseek-instant");
  assert.ok(!slugs.some((s) => s.startsWith("gpt-")), "and nothing of ChatGPT's");
});

test("and ChatGPT's picker is unaffected", () => {
  write(EXISTING);
  const slugs = allModels().map((m) => m.slug);
  assert.ok(slugs.includes("gpt-5-6"), "its discovered list is still read");
  assert.ok(!slugs.includes("deepseek-chat"));
});
