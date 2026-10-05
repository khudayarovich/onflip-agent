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

const { cutByStream } = require("../dist/chatgpt/browser-client");

const { pageCompletesStreamReply, replyMetaFor, __setStreamFromSseForTest } = require("../dist/chatgpt/browser-client");
const closingAnswer = "```onflip\ntool: done\nsummary: |\n  Everyday text chat has its own allowance. Other features can have separate limits.\n```";
const partialAnswer = closingAnswer.slice(0, 75);
const unfinishedView = (text = partialAnswer, extra = {}) => ({
  state: "done", error: null,
  visible: { status: "in_progress", finishType: null, text, textLen: text.length },
  ...extra,
});

test("a complete closing answer on the page can resolve a missing stream tail", () => {
  assert.equal(pageCompletesStreamReply(unfinishedView(), closingAnswer), true);
  const question = "````onflip\ntool: ask_user\nquestion: |\n  Which of these two designs do you prefer for your project?\n````";
  assert.equal(pageCompletesStreamReply(unfinishedView(question.slice(0, 75)), question), true);
  assert.equal(pageCompletesStreamReply(unfinishedView(), closingAnswer.replace("done", "ask_user")), false, "it must extend this reply");
});

test("missing-tail reconciliation never trusts an unfinished fence, a different reply, or a live stream", () => {
  assert.equal(pageCompletesStreamReply(unfinishedView(), closingAnswer.slice(0, -4)), false);
  assert.equal(pageCompletesStreamReply(unfinishedView(), "```onflip\ntool: done\nsummary: Another answer.\n```"), false);
  assert.equal(pageCompletesStreamReply(unfinishedView(), partialAnswer), false);
  assert.equal(pageCompletesStreamReply(unfinishedView(partialAnswer, { state: "streaming" }), closingAnswer), false);
  assert.equal(pageCompletesStreamReply(unfinishedView(partialAnswer, { state: "error" }), closingAnswer), false);
});

test("a closed fence never overrides explicit max_tokens or permits executable calls", () => {
  const limited = unfinishedView(); limited.visible.finishType = "max_tokens";
  assert.equal(pageCompletesStreamReply(limited, closingAnswer), false);
  const write = "```onflip\ntool: write\npath: app.css\ncontent: |\n  .player.top{\n```";
  assert.equal(pageCompletesStreamReply(unfinishedView(write.slice(0, 50)), write), false);
  assert.equal(pageCompletesStreamReply(unfinishedView(write.slice(0, 50)), `${write}\n${closingAnswer}`), false);
});

test("transport metadata clears inferred truncation only for an idle complete closing answer", () => {
  const frames = [
    { message: { id: "m", author: { role: "assistant" }, status: "in_progress", content: { content_type: "text", parts: [partialAnswer] } } },
    "[DONE]",
  ];
  const sse = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
  // Establish that this watcher ordinarily receives finished statuses.
  __setStreamFromSseForTest('data: {"message":{"id":"prior","author":{"role":"assistant"},"status":"finished_successfully","content":{"parts":["Done."]}}}\n\ndata: [DONE]\n\n');
  const after = __setStreamFromSseForTest(sse) - 1;
  assert.equal(replyMetaFor(after, { generatingAtAccept: false }, 0, partialAnswer).truncated, true);
  assert.equal(replyMetaFor(after, { generatingAtAccept: true }, 0, closingAnswer).truncated, true);
  assert.equal(replyMetaFor(after, { generatingAtAccept: false }, 0, closingAnswer).truncated, false);
  const explicitlyLimited = sse.replace('"status":"in_progress"', '"status":"in_progress","metadata":{"finish_details":{"type":"max_tokens"}}');
  const limitedAfter = __setStreamFromSseForTest(explicitlyLimited) - 1;
  assert.equal(replyMetaFor(limitedAfter, { generatingAtAccept: false }, 0, closingAnswer).truncated, true);
});

test("the status rule is only trusted once the stream has shown it reports one", () => {
  // Were ChatGPT to stop sending a message's final status, every reply would
  // end "in progress" — and every reply would be sent back as cut.
  const unfinished = { status: "in_progress", finishType: null };
  assert.equal(cutByStream("done", unfinished, false), false);
  assert.equal(cutByStream("done", unfinished, true), true);
  // ChatGPT's own length marker needs no such proof.
  assert.equal(cutByStream("done", { status: "finished_successfully", finishType: "max_tokens" }, false), true);
  assert.equal(cutByStream("done", { status: "finished_successfully", finishType: "stop" }, true), false);
});
