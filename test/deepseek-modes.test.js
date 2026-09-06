"use strict";

/**
 * DeepSeek's three modes, as OnFlip's model picker.
 *
 * Instant, Expert and Vision are a radio group above DeepSeek's composer and
 * the nearest thing it has to a model list, so that is what they are
 * presented as. The slugs map to the page's own `data-model-type` values —
 * `default`, `expert`, `vision` — and getting that mapping wrong would send
 * every turn to a mode nobody picked, silently.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-modes-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ONFLIP_PROVIDER = "deepseek";
fs.mkdirSync(path.join(HOME, ".onflip"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".onflip", "config.json"), JSON.stringify({ provider: "deepseek" }));

const { modeFor, DEEPSEEK_MODES } = require("../dist/providers/deepseek/browser");
const { allModels, defaultModel } = require("../dist/models");

test("the picker offers exactly the three modes the page has", () => {
  assert.deepEqual(
    allModels().map((m) => m.label),
    ["Instant", "Expert", "Vision"]
  );
});

test("each slug maps to the page's own data-model-type", () => {
  // Read off the live radio group: default, expert, vision.
  assert.equal(modeFor("deepseek-instant"), "default");
  assert.equal(modeFor("deepseek-expert"), "expert");
  assert.equal(modeFor("deepseek-vision"), "vision");
  assert.deepEqual(Object.values(DEEPSEEK_MODES).sort(), ["default", "expert", "vision"]);
});

test("Instant is the default, matching DeepSeek's own", () => {
  assert.equal(defaultModel(), "deepseek-instant");
  assert.equal(modeFor(defaultModel()), "default");
});

test("anything unknown falls back to Instant rather than nothing", () => {
  // `deepseek-chat` is the slug an earlier build stored, so a config written
  // by it must not select a mode that does not exist.
  assert.equal(modeFor("deepseek-chat"), "default");
  assert.equal(modeFor(undefined), "default");
  assert.equal(modeFor(""), "default");
  assert.equal(modeFor("gpt-5-6"), "default");
});
