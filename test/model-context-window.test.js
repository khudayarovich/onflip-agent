"use strict";

/**
 * The context window comes from the account, not from a table.
 *
 * ChatGPT's model list reports a `max_tokens` for every model, per account.
 * On a real Free account in September 2026 it said 34,834 for GPT-5.6 Luna
 * and 262,144 for its thinking variant, and a single typed message of 89,811
 * characters was read to its last line — while OnFlip's plan table still
 * said Free meant 8,000 tokens and sized the conversation at 2,000
 * characters, a summary and a fresh chat on almost every step.
 *
 * `node --test` runs each file in its own process, so redirecting the home
 * directory here cannot leak into another test or touch the real ~/.onflip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-window-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_CONFIG_DIR;
delete process.env.ONFLIP_PROVIDER;
delete process.env.ONFLIP_UPLOAD_ABOVE;

const CONFIG_DIR = path.join(HOME, ".onflip");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const setConfig = (config) =>
  fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify(config, null, 2));

const { normalise } = require("../dist/chatgpt/models-api");
const { modelContextTokens } = require("../dist/models");
const { compactionBudget, COMPOSER_CEILING_CHARS } = require("../dist/chatgpt/plans");

// The shape the endpoint answered with on the Free account, trimmed.
const FREE_LIST = {
  models: [
    { slug: "gpt-5-5", title: "GPT-5.5", max_tokens: 34834, tags: ["history_off_approved"] },
    { slug: "gpt-5-6", title: "GPT-5.6 Luna", max_tokens: 34834, tags: [] },
    { slug: "gpt-5-6-t-mini", title: "GPT-5.6 Luna", max_tokens: 262144, tags: [] },
    { slug: "odd", title: "Odd", max_tokens: "lots" },
    { slug: "negative", title: "Negative", max_tokens: -5 },
  ],
};

test("the model list keeps each model's window when the account gives one", () => {
  const models = normalise(FREE_LIST);
  const by = Object.fromEntries(models.map((m) => [m.slug, m.maxTokens]));
  assert.equal(by["gpt-5-6"], 34834);
  assert.equal(by["gpt-5-6-t-mini"], 262144);
  // Anything that is not a positive whole number is not a window.
  assert.equal(by.odd, undefined);
  assert.equal(by.negative, undefined);
});

test("a cached window is the model's window, before any published figure", () => {
  setConfig({
    planType: "free",
    discoveredModels: [
      { slug: "gpt-5-6", title: "GPT-5.6 Luna", description: "", maxTokens: 34834 },
      { slug: "gpt-5-6-mini", title: "GPT-5.6 Luna", description: "" },
    ],
  });
  assert.equal(modelContextTokens("gpt-5-6"), 34834);
  // No figure cached for this one, and Luna has no published window.
  assert.equal(modelContextTokens("gpt-5-6-mini"), null);
});

test("the account's figure outranks the published one for a paid Sol", () => {
  setConfig({
    planType: "pro",
    discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "", maxTokens: 196608 }],
  });
  assert.equal(modelContextTokens("gpt-5-6"), 196608);
  // Without one, the published million-token window still stands.
  setConfig({ planType: "pro", discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "" }] });
  assert.equal(modelContextTokens("gpt-5-6"), 1_050_000);
});

test("a Free account sized from its own window keeps the full typed budget", () => {
  setConfig({
    planType: "free",
    discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Luna", description: "", maxTokens: 34834 }],
  });
  const budget = compactionBudget("free", false, modelContextTokens("gpt-5-6"), 23_000);
  assert.equal(budget, COMPOSER_CEILING_CHARS);
});
