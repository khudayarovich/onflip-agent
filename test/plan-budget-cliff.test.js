"use strict";

/**
 * How much transcript each plan keeps before it is summarised.
 *
 * Two field reports shaped this file. An external review of a live install
 * found `planType: "free"` stored while the account's own token said
 * `prolite` - the plan was only fetched when nothing was stored, and the
 * Free row sized every compaction at a tenth of the paid ones. And then a
 * real Free account (September 2026) showed the Free row itself was wrong:
 * its model list reported 34,834 tokens for GPT-5.6 Luna and a typed message
 * of 89,811 characters was read to its last line, while the table still said
 * 8,000 tokens. With OnFlip's ~23,000-character instructions subtracted, that
 * left 2,000 characters of conversation - a summary, and a fresh chat, on
 * almost every step, which is what the user saw as several chats per task,
 * forgotten work and the throttle that followed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { compactionBudget, promptCrowdsPlan, COMPOSER_CEILING_CHARS } = require("../dist/chatgpt/plans");

// A realistic system prompt: it is subtracted from the window before the
// transcript gets any.
const SYSTEM = 23_000;

test("Free keeps as much transcript as a paid plan now that its window is known", () => {
  // Typing caps every plan at what one message carries; Free's 32k-token
  // window is no longer the smaller of the two.
  assert.equal(compactionBudget("free", false, null, SYSTEM), COMPOSER_CEILING_CHARS);
  assert.equal(compactionBudget("chatgptfreeplan", false, null, SYSTEM), COMPOSER_CEILING_CHARS);
});

test("Free is not crowded by the instructions any more", () => {
  // The notice said the conversation would summarise itself often; on a
  // 128k-character window a 23k prompt is a sixth of it.
  assert.equal(promptCrowdsPlan("free", SYSTEM), null);
});

test("the account's own window for the model outranks the plan table", () => {
  // What the model list reported on a real Free account.
  assert.equal(compactionBudget("free", false, 34_834, SYSTEM), COMPOSER_CEILING_CHARS);
  // And it still protects a genuinely small window: 8k tokens with a 23k
  // prompt leaves room for barely any conversation, and the budget says so
  // instead of letting the prompt be pushed out of the window.
  const small = compactionBudget(undefined, false, 8_000, SYSTEM);
  assert.ok(small < 5_000, `an 8k-token window leaves ${small} characters`);
  assert.ok(small >= 2_000);
});

test("typing caps a huge window at what one message carries", () => {
  // Sol's million-token window is not reachable through the composer.
  assert.equal(compactionBudget("pro", false, 1_050_000, SYSTEM), COMPOSER_CEILING_CHARS);
  // Uploads, which are opt-in, keep their own larger ceiling.
  assert.ok(compactionBudget("pro", true, 1_050_000, SYSTEM) > COMPOSER_CEILING_CHARS);
});

test("every paid plan lands on the composer ceiling, not the plan window", () => {
  // With turns typed rather than uploaded, what one message can carry is the
  // binding limit - so Plus, Pro Lite and Pro all sit at the same place and a
  // wrong-but-paid plan value costs nothing.
  for (const plan of ["plus", "prolite", "pro", "team", "business", "enterprise"]) {
    assert.equal(compactionBudget(plan, false, null, SYSTEM), COMPOSER_CEILING_CHARS, plan);
  }
});

test("an unread plan is not treated as a small one", () => {
  // The first turn of a fresh install has no plan yet.
  assert.equal(compactionBudget(undefined, false, null, SYSTEM), COMPOSER_CEILING_CHARS);
  assert.equal(compactionBudget("", false, null, SYSTEM), COMPOSER_CEILING_CHARS);
});
