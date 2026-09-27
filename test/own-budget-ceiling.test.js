"use strict";

/**
 * How far a person's own "compact after" can usefully go.
 *
 * From a Windows PC set to 280,000 on a Free account: the transcript grew to
 * 212,000 characters in one ChatGPT thread whose model holds about 139,000,
 * and every lost chat went back as one typed message cut at 80,000. The
 * setting is honoured up to what works and capped there.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { ownBudgetCeiling, TYPED_MESSAGE_CEILING_CHARS } = require("../dist/chatgpt/plans");

const PROMPT = 23_000;

test("typed turns on a Free Luna: one message is the lower limit", () => {
  const cap = ownBudgetCeiling(false, 34_834, PROMPT);
  assert.deepEqual(cap, { chars: TYPED_MESSAGE_CEILING_CHARS - PROMPT, because: "one message" });
});

test("with uploads on, the model's window is what bounds it", () => {
  const cap = ownBudgetCeiling(true, 34_834, PROMPT);
  assert.equal(cap.because, "the model");
  // The window in characters, less the prompt and room for a reply.
  assert.equal(cap.chars, 34_834 * 4 - PROMPT - 8_000);
});

test("a window smaller than one message binds a typed session too", () => {
  const cap = ownBudgetCeiling(false, 16_000, PROMPT);
  assert.equal(cap.because, "the model");
  assert.equal(cap.chars, 16_000 * 4 - PROMPT - 8_000);
});

test("nothing known that bounds it: no cap", () => {
  assert.equal(ownBudgetCeiling(true, null, PROMPT), null);
  assert.equal(ownBudgetCeiling(true, undefined, PROMPT), null);
});

test("a prompt that swallows the limit still leaves a working floor", () => {
  assert.equal(ownBudgetCeiling(false, null, 95_000).chars, 12_000);
});
