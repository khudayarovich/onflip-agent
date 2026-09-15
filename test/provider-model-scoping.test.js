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
  assert.equal(defaultModel(), "deepseek-chat");
  assert.deepEqual(
    allModels().map((m) => m.slug),
    ["deepseek-chat"]
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

test("ChatGPT's identity misfiled into another service's room is ignored", () => {
  // The shape found on a real machine: a cross-provider bleed from before
  // ONFLIP_PROVIDER pinning had written ChatGPT's account and its discovered
  // model list into providers.deepseek, and the app read them straight back
  // out - so DeepSeek wore a ChatGPT name through every restart.
  fs.writeFileSync(
    path.join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      provider: "deepseek",
      accountName: "Someone ChatGPT",
      accountEmail: "chatgpt@example.com",
      sessionToken: "chatgpt-session",
      providers: {
        deepseek: {
          model: "deepseek-instant",
          accountName: "Someone ChatGPT",
          accountEmail: "chatgpt@example.com",
          discoveredModels: [{ slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "" }],
        },
      },
    })
  );

  const cfg = loadConfig();
  // discoveredModels is ChatGPT's own endpoint speaking; DeepSeek's list is a
  // built-in constant, so a copy in its room is always misfiled.
  assert.equal(cfg.discoveredModels, undefined, "a gpt model list must not be read on DeepSeek");
  assert.equal(cfg.sessionToken, undefined, "nor a ChatGPT session");
  assert.equal(cfg.model, "deepseek-instant", "the room's own model still reads");
  // The picker is unaffected either way - it never consults the cache here,
  // and it is DeepSeek's own list whatever ChatGPT left lying in the room.
  assert.deepEqual(
    allModels().map((m) => m.slug),
    ["deepseek-chat"]
  );
  // The account name IS dropped now, and this assertion is the record of a
  // policy that changed.
  //
  // It used to be kept, on the reasoning that both services have accounts and
  // a misfiled one would be corrected by re-reading it from the service. That
  // held while DeepSeek was the only other service: DeepSeek's page names the
  // account, so its next turn overwrites the wrong name.
  //
  // Qwen broke the reasoning rather than the code. Its page carries no name
  // and no email anywhere — measured on the live page — so `pageSessionUser`
  // answers null, the identify step returns early, and a ChatGPT name in
  // `providers.qwen` would sit on the account bar for good. There is no
  // re-read to wait for.
  //
  // So a name identical to ChatGPT's own is treated as ChatGPT's and not read
  // back. A name the service really reported differs from it and survives —
  // which is what the fixture below this one checks.
  assert.equal(cfg.accountName, undefined, "identical to ChatGPT's, so it is ChatGPT's");
});

test("a name the service really reported is still read back", () => {
  // The guard on the rule above: it must be narrow enough to leave a genuine
  // account alone. Blanking the account bar of someone properly signed in
  // would be a worse bug than the one being fixed.
  fs.writeFileSync(
    path.join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      provider: "deepseek",
      accountName: "Someone ChatGPT",
      accountEmail: "chatgpt@example.com",
      providers: { deepseek: { accountName: "fas*****98@gmail.com" } },
    })
  );
  const cfg = loadConfig();
  assert.equal(cfg.accountName, "fas*****98@gmail.com");
});
