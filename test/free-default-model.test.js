"use strict";

/**
 * A Free account runs on the Luna that has no limit.
 *
 * Measured on a Free account in September 2026: its model list titles both
 * `gpt-5-6` and `gpt-5-6-mini` "GPT-5.6 Luna", and OnFlip took the first one
 * listed — `gpt-5-6`, which reasons "auto", draws on the plan's thinking
 * allowance and was the model ChatGPT's own start-up data listed under
 * `model_limits`. The unlimited one is `gpt-5-6-mini`, which never thinks. The
 * picker test that should have caught it had given `gpt-5-6` its paid-plan
 * title, "GPT-5.6 Sol", so the lists below are the ones the accounts sent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-free-default-"));
process.env.ONFLIP_CONFIG_DIR = DIR;
process.env.ONFLIP_PROVIDER = "chatgpt";
const { defaultModel, allModels, meteredOnPlan } = require("../dist/models");
const { normalise } = require("../dist/chatgpt/models-api");

const write = (config) => fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify(config));

/** A Free account's list, as it answered: slug, title, reasoning_type. */
const FREE = [
  ["gpt-5-5", "GPT-5.5", "auto"],
  ["gpt-5-6", "GPT-5.6 Luna", "auto"],
  ["gpt-5-3-mini", "GPT-5.3 Mini", "none"],
  ["gpt-5-5-mini", "GPT-5.5 Mini", "none"],
  ["gpt-5-6-mini", "GPT-5.6 Luna", "none"],
  ["gpt-5-4-t-mini", "GPT-5.4 Thinking Mini", "reasoning"],
  ["gpt-5-6-t-mini", "GPT-5.6 Luna", "reasoning"],
  ["gpt-5-6-t-mini-mini", "GPT-5.6 Luna", "reasoning"],
  ["research", "Deep Research", "none"],
  ["auto", "Auto", "auto"],
].map(([slug, title, reasoning]) => ({ slug, title, description: "Our latest and most advanced model", reasoning }));

/** The same list as a cache written before the field existed. */
const FREE_OLD_CACHE = FREE.map(({ reasoning: _r, ...m }) => m);

/** A Pro Lite account's list, as cached on 2026-09-12. */
const PRO_LITE = [
  ["gpt-5-5", "GPT-5.5"], ["gpt-5-5-instant", "GPT-5.5 Instant"], ["gpt-5-6", "GPT-5.6 Sol"],
  ["gpt-5-6-instant", "GPT-5.6 Sol"], ["gpt-5-5-thinking", "GPT-5.5 Thinking"], ["gpt-5-6-thinking", "GPT-5.6 Sol"],
  ["gpt-5.5-wm", "GPT-5.5"], ["gpt-5.6-sol-wm", "GPT-5.6 Sol"], ["gpt-5.6-terra-wm", "GPT-5.6 Terra"],
  ["gpt-5.6-luna-wm", "GPT-5.6 Luna"], ["gpt-6-astra-wm", "GPT-6 Astra"], ["gpt-5-5-pro", "GPT-5.5 Pro"],
  ["gpt-5-6-pro", "GPT-5.6 Pro"], ["gpt-6-pro", "GPT-6 Pro"], ["gpt-5-3-mini", "GPT-5.3 Mini"],
  ["gpt-5-5-mini", "GPT-5.5 Mini"], ["gpt-5-6-mini", "GPT-5.6 Luna"], ["gpt-5-6-t-mini", "GPT-5.6 Luna"],
  ["research", "Deep Research"],
].map(([slug, title]) => ({ slug, title, description: "" }));

test("the model list keeps what each model does about thinking", () => {
  const read = normalise({
    models: [
      { slug: "gpt-5-6", title: "GPT-5.6 Luna", reasoning_type: "auto" },
      { slug: "gpt-5-6-mini", title: "GPT-5.6 Luna", reasoning_type: " None " },
      { slug: "odd", reasoning_type: 7 },
    ],
  });
  assert.deepEqual(read.map((m) => m.reasoning), ["auto", "none", undefined]);
});

test("a Free account defaults to the Luna with no limit, not the first one listed", () => {
  write({ planType: "free", discoveredModels: FREE });
  assert.equal(defaultModel(), "gpt-5-6-mini");
});

test("a Free account is offered only the models it can run without a limit", () => {
  write({ planType: "free", discoveredModels: FREE });
  const offered = allModels();
  assert.deepEqual(offered.map((m) => m.slug), ["gpt-5-3-mini", "gpt-5-5-mini", "gpt-5-6-mini"]);
  // One Luna left, so its name no longer needs the slug to tell it apart.
  assert.equal(offered.find((m) => m.slug === "gpt-5-6-mini").label, "GPT-5.6 Luna");
});

test("a list cached before the field existed reaches the same answer", () => {
  write({ planType: "free", discoveredModels: FREE_OLD_CACHE });
  assert.equal(defaultModel(), "gpt-5-6-mini");
  assert.deepEqual(allModels().map((m) => m.slug), ["gpt-5-3-mini", "gpt-5-5-mini", "gpt-5-6-mini"]);
});

test("a paid plan's default and list are what they were", () => {
  write({ planType: "prolite", discoveredModels: PRO_LITE });
  assert.equal(defaultModel(), "gpt-5-6-mini");
  const slugs = allModels().map((m) => m.slug);
  assert.ok(slugs.includes("gpt-5-6"), "Sol is a paid plan's to use");
  assert.ok(slugs.includes("gpt-5-6-mini"));
});

test("a model is called limited only when the account's list says it thinks, on a rationed plan", () => {
  write({ planType: "free", discoveredModels: FREE });
  assert.equal(meteredOnPlan("gpt-5-6"), true);
  assert.equal(meteredOnPlan("gpt-5-6-mini"), false);
  assert.equal(meteredOnPlan("not-listed"), false);
  write({ planType: "free", discoveredModels: FREE_OLD_CACHE });
  assert.equal(meteredOnPlan("gpt-5-6"), false, "no field, no claim");
  write({ planType: "plus", discoveredModels: FREE });
  assert.equal(meteredOnPlan("gpt-5-6"), false);
});
