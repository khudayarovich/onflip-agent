"use strict";

/**
 * The engine puts a Free session on the Luna that has no limit.
 *
 * A Free account's list titles both `gpt-5-6` and `gpt-5-6-mini` "GPT-5.6
 * Luna", and only `gpt-5-6-mini` has no limit on that plan (see
 * `unlimitedOnRationedPlan` in models.ts). A session nobody pinned moves to
 * it; a pin stays, with a line saying what the account says about it; and a
 * list cached before the model's reasoning type was kept is read again once.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist", "engine", "engine.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-free-model-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";
delete process.env.ONFLIP_MODEL;

const FREE = [
  ["gpt-5-6", "GPT-5.6 Luna", "auto"],
  ["gpt-5-5-mini", "GPT-5.5 Mini", "none"],
  ["gpt-5-6-mini", "GPT-5.6 Luna", "none"],
  ["gpt-5-6-t-mini", "GPT-5.6 Luna", "reasoning"],
].map(([slug, title, reasoning]) => ({ slug, title, description: "", maxTokens: 34_834, reasoning }));

function makeEngine(config) {
  const cfg = require(path.join(ROOT, "dist", "config.js"));
  cfg.saveConfig({ model: undefined, modelPinned: undefined, thinking: undefined, ...config });
  const { Engine } = require(DIST);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const events = [];
  const peer = { emit: (event, data) => events.push({ event, data }), request: async () => ({ allow: true }) };
  const engine = new Engine(peer, work);
  engine.auth = { cookies: [], sessionToken: "", accessToken: "" };
  engine.transport = { name: "browser", send: async () => ({ content: "", conversationId: null }), reset() {} };
  const notices = () =>
    events.filter((e) => e.event === "item" && e.data?.type === "notice").map((e) => String(e.data.text));
  return { engine, cfg, notices };
}

test("a Free session nobody pinned moves from the limited Luna to the one with no limit", { skip: needsBuild }, () => {
  const { engine, cfg, notices } = makeEngine({ planType: "free", model: "gpt-5-6", modelPinned: false, discoveredModels: FREE });
  assert.equal(engine.model, "gpt-5-6");
  engine.adoptDefaultModel();
  assert.equal(engine.model, "gpt-5-6-mini");
  assert.equal(cfg.loadConfig().model, "gpt-5-6-mini");
  assert.ok(
    notices().some((n) => /GPT-5\.6 Luna \(gpt-5-6-mini\), which this plan can run without a message limit/.test(n)),
    notices().join(" | ")
  );
});

test("a pinned model with a limit stays, and the limit is named once", { skip: needsBuild }, () => {
  const { engine, cfg, notices } = makeEngine({ planType: "free", model: "gpt-5-6", modelPinned: true, discoveredModels: FREE });
  engine.adoptDefaultModel();
  assert.equal(engine.model, "gpt-5-6", "a pin is the person's choice");
  assert.equal(cfg.loadConfig().model, "gpt-5-6");
  const said = notices().filter((n) => /has a message limit/.test(n));
  assert.equal(said.length, 1, notices().join(" | "));
  assert.match(said[0], /gpt-5-6 has a message limit on the Free plan\. GPT-5\.6 Luna \(gpt-5-6-mini\) has none/);
});

test("a pinned model with no limit is left without a word", { skip: needsBuild }, () => {
  const { engine, notices } = makeEngine({ planType: "free", model: "gpt-5-5-mini", modelPinned: true, discoveredModels: FREE });
  engine.adoptDefaultModel();
  assert.equal(engine.model, "gpt-5-5-mini");
  assert.equal(notices().length, 0, notices().join(" | "));
});

test("the list is read again once when it does not say which model thinks, and keeps the answer", { skip: needsBuild, timeout: 20_000 }, async () => {
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  const modelsApi = require(path.join(ROOT, "dist", "chatgpt", "models-api.js"));
  providers.fetchAccountPlan = async () => "free";
  let asked = 0;
  modelsApi.discoverModels = async () => {
    asked++;
    return { source: "browser", models: FREE.map(({ slug, title, maxTokens, reasoning }) => ({ slug, title, description: "", tags: [], maxTokens, reasoning })) };
  };
  const oldCache = FREE.map(({ reasoning: _r, ...m }) => m);
  const { engine, cfg } = makeEngine({ planType: "free", model: "gpt-5-6", modelPinned: false, discoveredModels: oldCache });
  await engine.learnAccountModels();
  assert.equal(asked, 1);
  assert.equal(cfg.loadConfig().discoveredModels.find((m) => m.slug === "gpt-5-6-mini").reasoning, "none");
  // And, with the field in hand, the default follows it.
  assert.equal(engine.model, "gpt-5-6-mini");
  // Once: a list that says is not asked for again.
  await engine.learnAccountModels();
  assert.equal(asked, 1);
});
