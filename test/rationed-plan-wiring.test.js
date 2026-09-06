"use strict";

/**
 * That the plan actually reaches the three decisions it is supposed to.
 *
 * The predicate having the right membership proves nothing on its own — the
 * bug being fixed was not a wrong answer, it was three call sites that never
 * asked. So this points the config directory at a temp folder, writes a plan
 * into it, and checks what the transport and the model picker then decide.
 *
 * `node --test` runs each file in its own process, so redirecting the home
 * directory here cannot leak into another test or touch the real ~/.onflip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Before anything requires config.js: it resolves the directory once, at
// import time, from the home directory.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-plan-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// The upload path must be on by default, or "off on Free" would prove nothing.
delete process.env.ONFLIP_UPLOAD_ABOVE;

const CONFIG_DIR = path.join(HOME, ".onflip");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const setPlan = (planType, discoveredModels) => {
  fs.writeFileSync(
    path.join(CONFIG_DIR, "config.json"),
    JSON.stringify({ planType, discoveredModels }, null, 2)
  );
};

// Required after the home directory is redirected, not at the top.
const { uploadsAvailable, attachmentsBlockedReason } = require("../dist/chatgpt/transport");
const { effectiveModel, allModels } = require("../dist/models");

const MODELS = [
  { slug: "gpt-5-6-mini", title: "GPT-5.6 Luna", description: "" },
  { slug: "gpt-5-6", title: "GPT-5.6 Sol", description: "" },
  { slug: "gpt-5-6-thinking", title: "GPT-5.6 Sol", description: "" },
];

// --- uploads ----------------------------------------------------------------

test("a Free account never uploads a turn, however large", () => {
  // The bug: a turn over 45,000 characters was written to a file and sent as
  // an attachment, spending the one allowance that stops the session.
  setPlan("chatgptfreeplan", MODELS);
  assert.equal(uploadsAvailable(), false);
});

test("a paid account still uploads", () => {
  setPlan("chatgptplusplan", MODELS);
  assert.equal(uploadsAvailable(), true);
});

test("an unread plan keeps the old behaviour", () => {
  // The plan is not known on the first turn of a fresh install, and assuming
  // Free there would downgrade every account until it was read.
  setPlan(undefined, MODELS);
  assert.equal(uploadsAvailable(), true);
});

test("attachments are refused on Free and allowed on Plus", () => {
  setPlan("free", MODELS);
  const reason = attachmentsBlockedReason();
  assert.ok(reason, "Free should give a reason");
  assert.match(reason, /Free/);

  setPlan("plus", MODELS);
  assert.equal(attachmentsBlockedReason(), null);
});

// --- thinking ---------------------------------------------------------------

test("a thinking level opens no variant on Free", () => {
  // `-thinking` is not the same model reasoning harder — on these plans it is
  // the metered allowance under another name.
  setPlan("free", MODELS);
  assert.equal(effectiveModel("gpt-5-6", "high"), "gpt-5-6");
  assert.equal(effectiveModel("gpt-5-6", "low"), "gpt-5-6");
  assert.equal(effectiveModel("gpt-5-6", "off"), "gpt-5-6");
});

test("a thinking level still opens its variant on Plus", () => {
  setPlan("plus", MODELS);
  assert.equal(effectiveModel("gpt-5-6", "high"), "gpt-5-6-thinking");
});

// --- the model list ---------------------------------------------------------

test("Free is not offered the models it can run three times", () => {
  setPlan("free", MODELS);
  const slugs = allModels().map((m) => m.slug);

  assert.ok(slugs.includes("gpt-5-6-mini"), "Luna is the unlimited one and must stay");
  assert.ok(!slugs.includes("gpt-5-6"), "Sol comes out of the small allowance");
});

test("Plus keeps its full list", () => {
  setPlan("plus", MODELS);
  const slugs = allModels().map((m) => m.slug);
  assert.ok(slugs.includes("gpt-5-6"));
  assert.ok(slugs.includes("gpt-5-6-mini"));
});

test("a Free list with nothing recognisable is left alone, not emptied", () => {
  // A filter that hides every option is worse than one that hides none: an
  // empty picker is unusable, and the slug names are not a contract.
  setPlan("free", [{ slug: "something-new-2027", title: "Something New", description: "" }]);
  assert.equal(allModels().length, 1);
});
