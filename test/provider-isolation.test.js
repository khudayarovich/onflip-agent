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

const { loadConfig, saveConfig } = require("../dist/config");
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

// --- and the two symptoms that were reported --------------------------------

test("the model picker offers DeepSeek's one model, not ChatGPT's", () => {
  write({ ...EXISTING, provider: "deepseek" });
  const slugs = allModels().map((m) => m.slug);
  assert.deepEqual(slugs, ["deepseek-chat"]);
  assert.equal(defaultModel(), "deepseek-chat");
});

test("and ChatGPT's picker is unaffected", () => {
  write(EXISTING);
  const slugs = allModels().map((m) => m.slug);
  assert.ok(slugs.includes("gpt-5-6"), "its discovered list is still read");
  assert.ok(!slugs.includes("deepseek-chat"));
});
