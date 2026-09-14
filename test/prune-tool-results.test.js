"use strict";

/**
 * The cheap answer to a long transcript.
 *
 * Compaction is the expensive one: a summary request, then the conversation
 * is abandoned and everything replayed into a fresh one. Measured across
 * twenty-one sessions on one machine, the sends carrying that replay were
 * 36% of every character the app had ever sent.
 *
 * And most of what makes a transcript long is not conversation — it is tool
 * output. A file read, a directory listing, a build log: bulky, already acted
 * on, and the least useful thing to carry forward. Cutting the middle out of
 * the old ones costs no request at all, and when it is enough, the expensive
 * answer is not needed this turn.
 *
 * The idea is DeepSeek Harness's, whose compaction family trims oversized
 * tool output before condensing anything and skips summarising when trimming
 * relieved the pressure on its own.
 *
 * What these tests hold is the two things that make it safe rather than
 * merely smaller: the newest results are never touched, because they are what
 * the model is about to act on, and nothing is trimmed twice, because that
 * compounds until there is nothing readable left.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { pruneToolResults, PRUNE_ABOVE_CHARS, KEEP_RECENT } = require("../dist/agent/prune");

let counter = 0;
const result = (tool, chars) => ({
  id: `m${++counter}`,
  role: "user",
  content: "x".repeat(chars),
  toolName: tool,
});
const said = (role, text) => ({ id: `m${++counter}`, role, content: text });

/** A transcript with `n` big tool results in it, oldest first. */
function transcript(n, chars = 10_000) {
  const history = [said("system", "prompt"), said("user", "do the thing")];
  for (let i = 0; i < n; i++) {
    history.push(said("assistant", "calling a tool"));
    history.push(result("read", chars));
  }
  return history;
}

test("a long-past tool result loses its middle and keeps its ends", () => {
  const history = transcript(5);
  const before = history[3].content.length;
  const reclaimed = pruneToolResults(history);

  assert.ok(reclaimed > 0, "nothing was reclaimed");
  assert.ok(history[3].content.length < before);
  assert.match(history[3].content, /OnFlip cut [\d,]+ characters/);
  assert.match(history[3].content, /run the tool again rather than working from memory/);
});

test("the newest results are left alone, because the step is using them", () => {
  // Trimming what the model is about to act on breaks the step rather than
  // the budget. A read followed by an edit against what was read is the
  // ordinary shape of a turn.
  const history = transcript(5);
  const tools = history.filter((m) => m.toolName);
  const newest = tools.slice(-KEEP_RECENT).map((m) => m.content.length);
  pruneToolResults(history);
  assert.deepEqual(
    history.filter((m) => m.toolName).slice(-KEEP_RECENT).map((m) => m.content.length),
    newest
  );
});

test("nothing is ever trimmed twice", () => {
  // Compounding is the failure that would eat the head and tail as well,
  // leaving a result that says only that something was cut.
  const history = transcript(5);
  const first = pruneToolResults(history);
  const shapes = history.map((m) => m.content.length);
  const second = pruneToolResults(history);
  assert.ok(first > 0);
  assert.equal(second, 0, "a second pass found something to cut");
  assert.deepEqual(history.map((m) => m.content.length), shapes);
});

test("a small result is not worth the sentence explaining the cut", () => {
  const history = transcript(5, PRUNE_ABOVE_CHARS - 1);
  assert.equal(pruneToolResults(history), 0);
});

test("what a person said is never touched, however long", () => {
  // The `user` role carries three different things, and only one of them is
  // tool output. Cutting a person's own words would be unforgivable.
  const history = [
    said("system", "prompt"),
    said("user", "y".repeat(50_000)),
    said("assistant", "z".repeat(50_000)),
    result("read", 10_000),
    said("assistant", "done"),
    result("read", 10_000),
    result("read", 10_000),
  ];
  const person = history[1].content.length;
  const assistant = history[2].content.length;
  pruneToolResults(history);
  assert.equal(history[1].content.length, person);
  assert.equal(history[2].content.length, assistant);
});

test("a transcript with nothing old enough reclaims nothing", () => {
  const history = transcript(KEEP_RECENT);
  assert.equal(pruneToolResults(history), 0);
});

test("the saving is most of a big result", () => {
  // The number the whole thing is for: if it did not reclaim most of what a
  // bulky result costs, it would not be worth the risk of cutting at all.
  const history = transcript(3, 20_000);
  const before = history.reduce((n, m) => n + m.content.length, 0);
  const reclaimed = pruneToolResults(history);
  assert.ok(reclaimed > 18_000, `only ${reclaimed} reclaimed`);
  assert.equal(
    history.reduce((n, m) => n + m.content.length, 0),
    before - reclaimed,
    "the reported saving must match the transcript that is left"
  );
});
