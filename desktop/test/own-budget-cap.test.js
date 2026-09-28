"use strict";

/**
 * A person's own "compact after" is honoured up to what works, and the meter
 * says when it was capped.
 *
 * From a Windows PC set to 280,000 on a Free account: the meter read "212232
 * of 280000 chars", the model holds about 139,000, and every lost chat went
 * back as one typed message cut at 80,000 — refused, reloaded and replayed
 * for as long as the session lasted.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist", "engine", "engine.js");
const needsBuild = fs.existsSync(DIST) ? false : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-own-budget-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";
delete process.env.ONFLIP_MODEL;
delete process.env.ONFLIP_UPLOAD_ABOVE;

const LUNA = [{ slug: "gpt-5-6-mini", title: "GPT-5.6 Luna", description: "", maxTokens: 34_834, reasoning: "none" }];
const PROMPT = "S".repeat(23_000);

function makeEngine(config) {
  const cfg = require(path.join(ROOT, "dist", "config.js"));
  cfg.saveConfig({ compactAfterChars: undefined, ...config });
  const { Engine } = require(DIST);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const peer = { emit: () => {}, request: async () => ({ allow: true }) };
  const engine = new Engine(peer, work);
  engine.history = [{ role: "system", content: PROMPT }];
  return engine;
}

test("280,000 on a Free Luna, typed: capped at what one message can carry, and said so", { skip: needsBuild }, () => {
  const engine = makeEngine({ planType: "free", model: "gpt-5-6-mini", discoveredModels: LUNA, compactAfterChars: 280_000 });
  assert.equal(engine.contextBudgetChars(), 80_000 - PROMPT.length);
  assert.equal(engine.contextBudgetSource(), "your own setting, capped at what one message can carry");
});

test("a setting under the cap is honoured exactly", { skip: needsBuild }, () => {
  const engine = makeEngine({ planType: "free", model: "gpt-5-6-mini", discoveredModels: LUNA, compactAfterChars: 30_000 });
  assert.equal(engine.contextBudgetChars(), 30_000);
  assert.equal(engine.contextBudgetSource(), "your own setting");
});

test("with no setting, the automatic budget is untouched", { skip: needsBuild }, () => {
  const engine = makeEngine({ planType: "free", model: "gpt-5-6-mini", discoveredModels: LUNA });
  const { compactionBudget } = require(path.join(ROOT, "dist", "chatgpt", "plans.js"));
  assert.equal(engine.contextBudgetChars(), compactionBudget("free", false, 34_834, PROMPT.length));
});

test("an own setting can be handed back to automatic, and Settings is told which it is", { skip: needsBuild }, () => {
  // There was no way back: the Settings field saved only another number, so
  // the 280,000 typed on that PC stayed until someone edited config.json.
  const engine = makeEngine({ planType: "free", model: "gpt-5-6-mini", discoveredModels: LUNA, replyTimeout: 900 });
  const cfg = require(path.join(ROOT, "dist", "config.js"));
  let view = engine.setConfigValue("compactAfterChars", 280_000);
  assert.equal(view.compactAfterCharsOwn, true);
  assert.equal(view.compactAfterChars, 280_000, "the number shown is the one typed");
  view = engine.setConfigValue("compactAfterChars", null);
  assert.equal(cfg.loadConfig().compactAfterChars, undefined, "gone from the file");
  assert.equal(view.compactAfterCharsOwn, false);
  assert.equal(view.compactAfterChars, engine.contextBudgetChars(), "and the box shows the automatic size");
  assert.equal(engine.contextBudgetSource(), "what one message can carry");
  assert.equal(cfg.loadConfig().replyTimeout, 900, "nothing else is touched");
});

test("an emptied box means the same as the button", { skip: needsBuild }, () => {
  const engine = makeEngine({ planType: "free", model: "gpt-5-6-mini", discoveredModels: LUNA, compactAfterChars: 60_000 });
  const cfg = require(path.join(ROOT, "dist", "config.js"));
  engine.setConfigValue("compactAfterChars", "  ");
  assert.equal(cfg.loadConfig().compactAfterChars, undefined);
});

test("on DeepSeek the shared key is found where it lives, at the top of the file", { skip: needsBuild }, () => {
  // `clearConfigKeys` clears only the active service's room, which is right
  // for sessions and wrong here: this key is shared, so on DeepSeek it
  // would have been left in place with the button reporting success.
  process.env.ONFLIP_PROVIDER = "deepseek";
  try {
    const engine = makeEngine({ compactAfterChars: 150_000 });
    const raw = () => JSON.parse(fs.readFileSync(path.join(process.env.ONFLIP_CONFIG_DIR, "config.json"), "utf8"));
    assert.equal(raw().compactAfterChars, 150_000);
    const view = engine.setConfigValue("compactAfterChars", null);
    assert.equal(raw().compactAfterChars, undefined);
    assert.equal(view.compactAfterCharsOwn, false);
  } finally {
    process.env.ONFLIP_PROVIDER = "chatgpt";
  }
});

test("DeepSeek's own setting passes as it is", { skip: needsBuild }, () => {
  process.env.ONFLIP_PROVIDER = "deepseek";
  try {
    const engine = makeEngine({ compactAfterChars: 280_000 });
    assert.equal(engine.contextBudgetChars(), 280_000);
    assert.equal(engine.contextBudgetSource(), "your own setting");
  } finally {
    process.env.ONFLIP_PROVIDER = "chatgpt";
  }
});
