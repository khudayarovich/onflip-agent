"use strict";

/**
 * Which provider a run is driving, and where it keeps its things.
 *
 * The whole safety story of adding a second provider rests on two promises
 * this file checks: that anything unset or unrecognised means ChatGPT, and
 * that ChatGPT's own directories do not move. If either breaks, an upgrade
 * either strands someone on a provider they never signed in to, or leaves
 * their sessions somewhere the app no longer looks.
 *
 * The home directory is redirected before anything reads it, and node's test
 * runner gives each file its own process, so this cannot touch a real
 * ~/.onflip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-provider-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_PROVIDER;
fs.mkdirSync(path.join(HOME, ".onflip"), { recursive: true });

const write = (cfg) =>
  fs.writeFileSync(path.join(HOME, ".onflip", "config.json"), JSON.stringify(cfg));

const {
  activeProvider,
  providerStateDir,
  providerLabel,
  isProviderId,
  DEFAULT_PROVIDER,
} = require("../dist/providers/id");

// --- what counts as a provider ---------------------------------------------

test("the two known ids are accepted and nothing else is", () => {
  assert.equal(isProviderId("chatgpt"), true);
  assert.equal(isProviderId("deepseek"), true);
  assert.equal(isProviderId("gemini"), false);
  assert.equal(isProviderId(""), false);
  assert.equal(isProviderId(undefined), false);
  assert.equal(isProviderId(42), false);
});

// --- the fallback, which is the safety property ----------------------------

test("no provider written means ChatGPT", () => {
  // Every install that predates providers is this case.
  write({});
  assert.equal(activeProvider(), "chatgpt");
  assert.equal(DEFAULT_PROVIDER, "chatgpt");
});

test("a value nobody recognises means ChatGPT, not a broken run", () => {
  // A hand-edited or corrupted config must not be able to strand someone on
  // a provider they have never signed in to.
  write({ provider: "gemini" });
  assert.equal(activeProvider(), "chatgpt");
  write({ provider: "" });
  assert.equal(activeProvider(), "chatgpt");
  write({ provider: 7 });
  assert.equal(activeProvider(), "chatgpt");
});

test("a provider that was chosen is honoured", () => {
  write({ provider: "deepseek" });
  assert.equal(activeProvider(), "deepseek");
});

test("the environment overrides the config, and junk in it does not", () => {
  write({ provider: "chatgpt" });
  process.env.ONFLIP_PROVIDER = "deepseek";
  assert.equal(activeProvider(), "deepseek");
  process.env.ONFLIP_PROVIDER = "  DeepSeek  ";
  assert.equal(activeProvider(), "deepseek", "trimmed and lowercased");
  process.env.ONFLIP_PROVIDER = "nonsense";
  assert.equal(activeProvider(), "chatgpt", "junk falls through to the config's default");
  delete process.env.ONFLIP_PROVIDER;
});

// --- where each provider keeps its state -----------------------------------

test("ChatGPT's directory does not move", () => {
  // The promise that makes this upgrade safe: no migration, because nothing
  // ChatGPT owns changes path.
  const dir = providerStateDir("chatgpt");
  assert.equal(dir, path.join(HOME, ".onflip"));
  assert.equal(path.join(dir, "sessions"), path.join(HOME, ".onflip", "sessions"));
});

test("a second provider gets a directory of its own", () => {
  assert.equal(providerStateDir("deepseek"), path.join(HOME, ".onflip", "providers", "deepseek"));
});

test("the two cannot collide", () => {
  assert.notEqual(providerStateDir("chatgpt"), providerStateDir("deepseek"));
});

test("names are spelled for people", () => {
  assert.equal(providerLabel("chatgpt"), "ChatGPT");
  assert.equal(providerLabel("deepseek"), "DeepSeek");
});
