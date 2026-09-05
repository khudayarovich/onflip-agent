"use strict";

/**
 * The refusal detectors, and the answers they must not mistake for refusals.
 *
 * These are ~46 regular expressions across English, Russian and Uzbek, and
 * every one of them was added after a live reply slipped past the previous
 * set. That is a pattern that only grows: each new alternative widens the net
 * over the other forty-five, and nothing here was guarding against a false
 * positive. The `answers` half of this file is that guard — a detector firing
 * on a real answer turns a finished turn into a pointless nudge, which is a
 * worse failure than the one it was added to catch.
 *
 * Each positive case is a reply that actually arrived, quoted from the notes
 * in AGENTS.md that record it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifySlip,
  detectToolDenial,
  detectPermissionRequest,
  detectFabrication,
  detectWorkHandoff,
  looksCutOff,
} = require("../dist/agent/run");

/** Nothing has run and nothing was denied — where the detectors apply. */
const fresh = (text) => classifySlip(text, 0, 0);

// ---------------------------------------------------------------------------
// denials: the model conceding the tools exist and declining to use them
// ---------------------------------------------------------------------------

test("a named tool behind “can't” is a denial", () => {
  assert.equal(
    fresh("I'm sorry, but I can't execute the local file-editing tool in this turn."),
    "denial"
  );
});

test("a denial whose subject is the runtime rather than the model", () => {
  // Past tense, and the subject is the harness — both earlier shapes missed
  // it, and the excuse went to the user as the answer.
  assert.equal(
    fresh(
      "The OnFlip tool runtime did not execute any machine-side calls in this turn, so I have not modified the file."
    ),
    "denial"
  );
});

test("a denial whose subject is a channel, with the negation before the word tool", () => {
  assert.equal(
    fresh(
      "The machine-side OnFlip execution channel is not actually exposed as an invokable tool in this conversation."
    ),
    "denial"
  );
});

test("a tool that belongs to the user's own project is an answer, not a denial", () => {
  // The disambiguator that keeps a real answer about someone's codebase from
  // being read as the model refusing its own tools.
  assert.equal(
    detectToolDenial("The export tool in your app is not accessible from the settings page."),
    false
  );
  assert.equal(
    detectToolDenial("The upload tool in your project is not wired up to the API yet."),
    false
  );
});

// ---------------------------------------------------------------------------
// permission slips: the model asking for approval that is OnFlip's to give
// ---------------------------------------------------------------------------

test("asking the user to approve a command is a permission slip", () => {
  assert.equal(fresh("Approve this and I'll run the build."), "permission");
});

test("a genuine question about what to do is not a permission slip", () => {
  assert.equal(
    detectPermissionRequest("Which of the two config files should I update?"),
    false
  );
});

// ---------------------------------------------------------------------------
// hand-offs to ChatGPT's own agent product
// ---------------------------------------------------------------------------

test("the Work hand-off card is a refusal in a friendlier shape", () => {
  // Work runs on OpenAI's computers and cannot see the user's, so the card is
  // a refusal — it claims nothing and asks nothing, which is why it needs its
  // own detector ahead of the others.
  assert.ok(detectWorkHandoff("Continue in ChatGPT Work\nContinuing…"));
});

test("prose mentioning the product is not a hand-off", () => {
  assert.equal(
    detectWorkHandoff("You could also do this in ChatGPT Work, but the local build is faster."),
    false
  );
});

// ---------------------------------------------------------------------------
// fabrication: claiming output before anything has run
// ---------------------------------------------------------------------------

test("claiming a command ran, before any tool call, is fabrication", () => {
  assert.equal(fresh("I ran the build and it passed with no errors."), "fabrication");
});

test("the same sentence after tools have run is an accurate summary", () => {
  // This is the rule that keeps fabrication detection from rejecting the
  // closing answer of almost every successful turn.
  assert.equal(classifySlip("I ran the build and it passed with no errors.", 3, 0), null);
  assert.equal(
    classifySlip("I read src/index.ts and the export is already there.", 1, 0),
    null
  );
});

test("claiming to have read a file before any tool ran is also fabrication", () => {
  // Reading a file needs a tool call, so with none behind it this sentence
  // is an invention however reasonable it sounds.
  assert.equal(
    fresh("I read src/index.ts and the export is already there, so nothing needs changing."),
    "fabrication"
  );
});

test("fabrication is not flagged when the reply only plans to run something", () => {
  assert.equal(detectFabrication("I'll run the build next."), false);
});

// ---------------------------------------------------------------------------
// truncation
// ---------------------------------------------------------------------------

test("an unclosed fence is a truncated stream, not an answer", () => {
  assert.ok(looksCutOff("Here is the fix:\n\n```js\nconst x = 1;"));
});

test("a balanced reply is not cut off", () => {
  assert.equal(looksCutOff("Here is the fix:\n\n```js\nconst x = 1;\n```\n\nThat is all."), false);
});

// ---------------------------------------------------------------------------
// the half with teeth: real answers must classify as nothing at all
// ---------------------------------------------------------------------------

test("ordinary answers are not slips", () => {
  const answers = [
    "The bug is on line 42: the loop starts at 1 instead of 0.",
    "There are three callers of this function, in api.ts, cli.ts and worker.ts.",
    "That file does not exist in the repository.",
    "Both approaches work. The second is faster because it avoids the copy.",
    "Done — the test passes now.",
  ];
  for (const answer of answers) {
    assert.equal(fresh(answer), null, `misclassified as ${fresh(answer)}: ${answer}`);
  }
});

test("hand-backs are legitimate ways to end a turn", () => {
  // "I'll leave that to you" and friends are correct endings, and treating
  // them as abandonment would nag the user at the end of every such turn.
  const handbacks = [
    "I'll leave that decision to you.",
    "You'll need to install Go before this can build.",
    "I'll wait for your call on which database to use.",
  ];
  for (const text of handbacks) {
    assert.equal(fresh(text), null, `misclassified as ${fresh(text)}: ${text}`);
  }
});

test("a report about an error is not a claim to have caused it", () => {
  assert.equal(detectFabrication("I'm seeing the same error you described."), false);
});
