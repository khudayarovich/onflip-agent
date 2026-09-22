"use strict";

/**
 * State that belongs to one service stays with it.
 *
 * - A cooldown was saved at the top level of the config, which is ChatGPT's
 *   room: a DeepSeek throttle made ChatGPT refuse to send and switched off
 *   its auto-resume, for a limit ChatGPT never set.
 * - The model pin was shared the same way, so picking a Qwen model pinned
 *   ChatGPT's choice.
 * - Arena's model names were left in ChatGPT's slot by builds before 0.10.51
 *   (seen on the developer's own machine: `"model": "arena-max"`), and an
 *   unknown slug is passed through by design — so ChatGPT opened chats with
 *   `?model=arena-max`, ran its default, and the chip said otherwise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-scope-"));
const { loadConfig, saveConfig } = require("../dist/config");
const { normalizeModel, defaultModel } = require("../dist/models");

const as = (provider, fn) => {
  const previous = process.env.ONFLIP_PROVIDER;
  process.env.ONFLIP_PROVIDER = provider;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ONFLIP_PROVIDER;
    else process.env.ONFLIP_PROVIDER = previous;
  }
};

test("a DeepSeek cooldown does not stop ChatGPT", () => {
  const until = Date.now() + 5 * 60_000;
  as("deepseek", () => saveConfig({ cooldownUntil: until }));
  assert.equal(as("deepseek", () => loadConfig().cooldownUntil), until);
  assert.equal(as("chatgpt", () => loadConfig().cooldownUntil), undefined);
});

test("and a ChatGPT cooldown stays ChatGPT's", () => {
  const until = Date.now() + 60_000;
  as("chatgpt", () => saveConfig({ cooldownUntil: until }));
  assert.equal(as("qwen", () => loadConfig().cooldownUntil), undefined);
  as("chatgpt", () => saveConfig({ cooldownUntil: undefined }));
});

test("pinning a model on one service pins nothing on another", () => {
  as("qwen", () => saveConfig({ model: "qwen3-max", modelPinned: true }));
  assert.equal(as("chatgpt", () => loadConfig().modelPinned), undefined);
  assert.equal(as("qwen", () => loadConfig().modelPinned), true);
});

test("a model name from a service OnFlip no longer drives names the default", () => {
  as("chatgpt", () => {
    assert.equal(normalizeModel("arena-max"), defaultModel());
    assert.equal(normalizeModel("gpt-5-6"), "gpt-5-6", "real ChatGPT slugs are untouched");
  });
});
