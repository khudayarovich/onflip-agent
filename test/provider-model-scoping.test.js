"use strict";

/**
 * Which model a service runs, and which one it says it is running.
 *
 * Reported from macOS as "provider is deepseek but the model shows gpt",
 * with a config holding `model: "gpt-5-6"` beside `provider: "deepseek"`.
 * That config is correct and is pinned here: the top level IS ChatGPT's
 * room, so its model sits there while DeepSeek's lives under
 * `providers.deepseek`. A "fix" that collapsed the two into one canonical
 * model would reintroduce the cross-service bleed the scoping exists to
 * stop - so these tests guard the layout as much as the behaviour.
 *
 * The real defect was elsewhere: a session remembers the model it ran on,
 * and restoring one adopted that slug without asking whose it was.
 *
 * `node --test` gives each file its own process, so redirecting the home
 * directory here cannot touch the real ~/.onflip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-model-scope-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_PROVIDER;

const CONFIG_DIR = path.join(HOME, ".onflip");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Exactly the shape from the report.
fs.writeFileSync(
  path.join(CONFIG_DIR, "config.json"),
  JSON.stringify(
    {
      model: "gpt-5-6",
      thinking: "medium",
      provider: "deepseek",
      discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "" }],
      providers: { deepseek: { accountName: "someone" } },
    },
    null,
    2
  )
);

const { loadConfig } = require("../dist/config");
const {
  allModels,
  defaultModel,
  modelBelongsToProvider,
} = require("../dist/models");

const onProvider = (id, fn) => {
  const had = process.env.ONFLIP_PROVIDER;
  process.env.ONFLIP_PROVIDER = id;
  try {
    fn();
  } finally {
    if (had === undefined) delete process.env.ONFLIP_PROVIDER;
    else process.env.ONFLIP_PROVIDER = had;
  }
};

test("ChatGPT's model stays at the top level and never leaks into DeepSeek", () => {
  // The reported config, read while DeepSeek is the service: the gpt slug is
  // ChatGPT's own setting and must be invisible here.
  assert.equal(loadConfig().model, undefined, "the top-level gpt slug must not be read on DeepSeek");
  assert.equal(loadConfig().thinking, undefined, "nor any other per-service setting");
  assert.equal(defaultModel(), "deepseek-instant");
  assert.deepEqual(
    allModels().map((m) => m.slug),
    ["deepseek-instant", "deepseek-expert", "deepseek-vision"]
  );
});

test("a foreign slug has no label, which is how it reached the screen", () => {
  // The composer falls back to the raw slug when the picker has no label for
  // it, so a ChatGPT model restored on DeepSeek renders as "gpt-5-6".
  assert.equal(
    allModels().find((m) => m.slug === "gpt-5-6"),
    undefined
  );
});

test("a model is refused only when it plainly belongs to the other service", () => {
  onProvider("deepseek", () => {
    assert.equal(modelBelongsToProvider("deepseek-instant"), true);
    assert.equal(modelBelongsToProvider("deepseek-vision"), true);
    assert.equal(modelBelongsToProvider("gpt-5-6"), false);
  });
  onProvider("chatgpt", () => {
    assert.equal(modelBelongsToProvider("gpt-5-6"), true);
    assert.equal(modelBelongsToProvider("deepseek-instant"), false);
    // Coarse on purpose: ChatGPT's list is discovered per account, and a slug
    // the user typed by hand is legitimate even when it is not in it. Asking
    // "is it in the list" here would throw away a working model.
    assert.equal(modelBelongsToProvider("gpt-9-unreleased"), true);
  });
});
