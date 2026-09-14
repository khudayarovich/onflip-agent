"use strict";

/**
 * DeepSeek unified Instant, Expert and Vision on 14 September 2026.
 *
 * Checked on the live page rather than taken from the announcement: the
 * control OnFlip clicked to choose a mode — `[role=radio][data-model-type]`
 * — returns zero elements, and what is left beside the composer is the
 * DeepThink toggle and Search, both still carrying `aria-pressed`.
 *
 * The picker went on offering all three. Choosing one did nothing, and it
 * did nothing quietly: `setMode` finds no radio group, and the code read
 * that absence as the ordinary mid-conversation case — which it was, right
 * up until it wasn't. Three labels, one behaviour, no error anywhere.
 *
 * That is the shape of every failure this driver has: the service redesigns
 * its page and a click that finds nothing does nothing. So the fix is one
 * model, a migration for anything stored under a retired name, and the
 * absence said out loud instead of swallowed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ONFLIP_PROVIDER = "deepseek";
const { allModels, normalizeModel, defaultModel, modelBelongsToProvider } = require("../dist/models");
const { modeFor, DEEPSEEK_MODES } = require("../dist/providers/deepseek/browser");

test("the picker offers what the page offers: one model", () => {
  const models = allModels();
  assert.equal(models.length, 1, `still offering ${models.map((m) => m.label).join(", ")}`);
  assert.equal(models[0].slug, "deepseek-chat");
});

test("every retired mode opens the model that replaced it", () => {
  // A config or a session written before the change names one of these. It
  // has to open something real rather than pin the run to a slug nothing
  // answers to and no label exists for.
  for (const old of ["deepseek-instant", "deepseek-expert", "deepseek-vision"]) {
    assert.equal(normalizeModel(old), "deepseek-chat", old);
  }
});

test("and the survivor is what a fresh session starts on", () => {
  assert.equal(defaultModel(), "deepseek-chat");
  assert.equal(modelBelongsToProvider("deepseek-chat"), true);
});

test("a retired slug still maps to its page mode, in case the chooser returns", () => {
  // Kept rather than deleted: the cost of keeping it is four lines, and the
  // cost of being wrong about whether DeepSeek brings modes back is another
  // silent no-op.
  assert.equal(modeFor("deepseek-expert"), "expert");
  assert.equal(modeFor("deepseek-vision"), "vision");
  assert.equal(modeFor("deepseek-chat"), "default");
  assert.equal(modeFor(undefined), "default");
  assert.ok(DEEPSEEK_MODES["deepseek-chat"]);
});

test("nothing claims a mode the unified model does not have", () => {
  // The user-visible half: no label may promise Expert or Vision behaviour
  // when choosing it cannot reach a control that exists.
  const labels = allModels().map((m) => `${m.label} ${m.description}`).join(" ");
  assert.ok(!/\bExpert\b(?! used to)/.test(labels), labels);
  assert.ok(!/\bVision\b/.test(labels), labels);
});
