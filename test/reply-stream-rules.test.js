"use strict";

/**
 * What the reply stream says about a reply's end.
 *
 * Two live failures on a Free account, both on the wire and invisible in the
 * page. A 13,336-character reply's stream closed with its message still
 * `in_progress` and no finish at all — a cut the old check missed because it
 * only knew ChatGPT's own `max_tokens` marker — and a stylesheet was written
 * with its second half missing. And a correction was typed while the reply
 * before it was still streaming; it never became a message, and the turn
 * waited four minutes for an answer to nothing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { endedMidMessage, replyStillStreaming } = require("../dist/chatgpt/browser-client");

test("a stream that closed on a message still in progress is a cut", () => {
  assert.equal(endedMidMessage("done", { status: "in_progress", finishType: null }), true);
  assert.equal(endedMidMessage("error", { status: "in_progress", finishType: null }), true);
});

test("a finished message is not a cut, with or without a finish marker", () => {
  assert.equal(endedMidMessage("done", { status: "finished_successfully", finishType: "stop" }), false);
  // Most replies on the Free account finished without `finish_details`.
  assert.equal(endedMidMessage("done", { status: "finished_successfully", finishType: null }), false);
});

test("a stream still open, or one with no visible message, says nothing yet", () => {
  assert.equal(endedMidMessage("streaming", { status: "in_progress", finishType: null }), false);
  assert.equal(endedMidMessage("done", null), false);
  // A stop the user asked for carries its own finish type.
  assert.equal(endedMidMessage("done", { status: "in_progress", finishType: "interrupted" }), false);
});

test("the next message waits only while frames are still arriving", () => {
  const now = 1_000_000;
  assert.equal(replyStillStreaming({ state: "streaming", lastFrameAt: now - 2_000 }, now), true);
  // A connection that stays open with nothing on it is not trusted to be working.
  assert.equal(replyStillStreaming({ state: "streaming", lastFrameAt: now - 60_000 }, now), false);
  assert.equal(replyStillStreaming({ state: "done", lastFrameAt: now }, now), false);
  assert.equal(replyStillStreaming(null, now), false);
});
