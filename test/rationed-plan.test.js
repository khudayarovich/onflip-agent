"use strict";

/**
 * Staying on the unlimited path on a Free or Go account.
 *
 * These plans are not simply smaller. Since August 2026 they get unlimited
 * text chat on the small model, and draw everything else — file uploads, the
 * reasoning variants, the larger models — from small allowances that an agent
 * run empties in minutes and that then lock for hours.
 *
 * OnFlip was spending all three without being asked to: turns over 45,000
 * characters were uploaded rather than typed, a thinking level opened a
 * `-thinking` variant, and the picker offered models the plan can run a
 * handful of times. Reported as the app "hitting rate limits fast".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  rationedPlan,
  planLimitNote,
  planLimitCard,
  compactionBudget,
  COMPOSER_CEILING_CHARS,
} = require("../dist/chatgpt/plans");

// --- which plans ------------------------------------------------------------

test("Free and Go are rationed, however ChatGPT spells them", () => {
  // The account endpoint answers "free", "chatgptfreeplan", "chatgpt_go" and
  // more besides; they are all the same two plans.
  for (const id of ["free", "Free", "chatgptfreeplan", "chatgpt_free", "go", "chatgptgoplan"]) {
    assert.equal(rationedPlan(id), true, id);
  }
});

test("the paid plans are not", () => {
  for (const id of ["plus", "chatgptplusplan", "pro", "prolite", "team", "business", "enterprise"]) {
    assert.equal(rationedPlan(id), false, id);
  }
});

test("an unknown or unread plan is not treated as rationed", () => {
  // Guessing "free" from silence would quietly downgrade a paying account,
  // and the plan is often unread on the very first turn.
  assert.equal(rationedPlan(undefined), false);
  assert.equal(rationedPlan(""), false);
  assert.equal(rationedPlan("some-plan-invented-next-year"), false);
});

test("'go' is matched as a whole plan, not as two letters inside another", () => {
  // The reason normalizePlanId exists: a substring search for "go" finds it
  // in plenty of ids that are not the Go plan.
  assert.equal(rationedPlan("chatgptgovernmentplan"), false);
});

// --- what the user is told --------------------------------------------------

test("the card names the plan in its heading and explains in its body", () => {
  const free = planLimitCard("chatgptfreeplan");
  assert.equal(free.title, "Not available on Free");
  // The point is not "you cannot" but "here is the path that has no limit".
  assert.match(free.body, /unlimited/);
  assert.equal(planLimitCard("go").title, "Not available on Go");
});

test("the one-line form is the same card joined up", () => {
  // Telegram and the engine's own notices cannot draw a card.
  const card = planLimitCard("free");
  assert.equal(planLimitNote("free"), `${card.title}. ${card.body}`);
});

test("a paid plan has nothing to explain", () => {
  assert.equal(planLimitCard("plus"), undefined);
  assert.equal(planLimitNote("plus"), undefined);
  assert.equal(planLimitNote(undefined), undefined);
});

// --- the compaction budget follows ------------------------------------------

test("without uploads the composer sets the ceiling", () => {
  // Free's window is small enough that the plan governs; the point here is
  // that the no-upload branch is what runs.
  const budget = compactionBudget("free", false);
  assert.ok(budget > 0);
  assert.ok(
    budget <= COMPOSER_CEILING_CHARS,
    `budget ${budget} should not exceed the composer ceiling ${COMPOSER_CEILING_CHARS}`
  );
});

test("a paid plan with uploads still gets the bigger budget", () => {
  // The change must not quietly shrink what a paying account can hold.
  assert.ok(compactionBudget("pro", true) > compactionBudget("free", false));
});
