"use strict";

/**
 * DeepSeek's replies, from the chess-game run on the real service.
 *
 *  - A call came back in DeepSeek's own function-calling markup rather than
 *    a block — the exact bytes below — and was shown to the user as text.
 *  - An answer was taken as finished after 2.1 seconds of unchanged text, the
 *    next message was typed into a page still writing, and it sat ninety
 *    seconds unanswered; twice in one turn. The answer's own request is what
 *    now says when an answer is over.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTurn } = require("../dist/agent/protocol");
const { answerStillOpen, answerSettled, ANSWER_REQUEST } = require("../dist/providers/deepseek/browser");

// The reply as saved in the session, byte for byte: two fullwidth bars
// (U+FF5C) either side of DSML and a space before the keyword.
const LIVE =
  "I'll start the server with a simpler, dependency-free approach.\n" +
  "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"job_output\">\n" +
  "<｜｜DSML｜｜ parameter name=\"id\">job_1</｜｜DSML｜｜ parameter>\n" +
  "</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";

test("DeepSeek's own call markup is read as the call it plainly is", () => {
  const turn = parseTurn(LIVE, ["job_output", "bash", "read"]);
  assert.deepEqual(turn.calls, [{ tool: "job_output", arguments: { id: "job_1" } }]);
  assert.equal(turn.text, "I'll start the server with a simpler, dependency-free approach.");
});

test("the single-bar spelling, several parameters and several calls", () => {
  const reply = [
    "<｜DSML｜function_calls>",
    '<｜DSML｜invoke name="read">',
    '<｜DSML｜parameter name="path" string="true">src/app.js</｜DSML｜parameter>',
    '<｜DSML｜parameter name="limit" string="false">40</｜DSML｜parameter>',
    "</｜DSML｜invoke>",
    '<｜DSML｜invoke name="bash">',
    '<｜DSML｜parameter name="command" string="true">npm test</｜DSML｜parameter>',
    "</｜DSML｜invoke>",
    "</｜DSML｜function_calls>",
  ].join("\n");
  const turn = parseTurn(reply, ["read", "bash"]);
  assert.deepEqual(
    turn.calls.map((c) => [c.tool, c.arguments]),
    [
      ["read", { path: "src/app.js", limit: "40" }],
      ["bash", { command: "npm test" }],
    ]
  );
  assert.equal(turn.text, "");
});

test("a tool nobody registered stays prose, and so does talk about the markup", () => {
  assert.deepEqual(parseTurn(LIVE, ["bash"]).calls, []);
  const talk = "DeepSeek writes its calls in a markup called DSML; OnFlip reads blocks instead.";
  assert.deepEqual(parseTurn(talk, ["bash"]).calls, []);
  assert.equal(parseTurn(talk, ["bash"]).text, talk);
});

test("a block still wins, and the markup is not consulted beside one", () => {
  const reply = "```onflip\ntool: read\npath: a.txt\n```\n" + LIVE;
  assert.deepEqual(parseTurn(reply, ["read", "job_output"]).calls.map((c) => c.tool), ["read"]);
});

test("the answer request is DeepSeek's completion endpoint", () => {
  assert.ok(ANSWER_REQUEST.test("https://chat.deepseek.com/api/v0/chat/completion"));
  assert.ok(!ANSWER_REQUEST.test("https://chat.deepseek.com/api/v0/users/current"));
  assert.ok(!ANSWER_REQUEST.test("https://chat.deepseek.com/api/v0/chat/completion/extra"));
});

test("an open answer request holds the reply open, within reason", () => {
  const now = 1_000_000;
  assert.equal(answerStillOpen(1, now - 5_000, now), true);
  assert.equal(answerStillOpen(0, now - 5_000, now), false);
  // A request that never reported its end does not hold everything for ever.
  assert.equal(answerStillOpen(1, now - 11 * 60_000, now), false);
});

test("still text ends an answer only once its request has closed", () => {
  const now = 1_000_000;
  assert.equal(answerSettled(0, now - 5_000, 2_100, now), true);
  // A pause mid-answer: two seconds still, request open — not the end.
  assert.equal(answerSettled(1, now - 5_000, 2_100, now), false);
  // A minute of stillness is believed whatever the wire says.
  assert.equal(answerSettled(1, now - 70_000, 60_000, now), true);
});

const { answerNeverStarted } = require("../dist/providers/deepseek/browser");

test("a send whose answer request never went out is called lost in seconds, not ninety", () => {
  const sentAt = 1_000_000;
  // Proven watcher, no answer request since the send, 26 seconds on: lost.
  assert.equal(answerNeverStarted(3, sentAt - 60_000, sentAt, sentAt + 26_000), true);
  // Still inside the grace period: keep waiting.
  assert.equal(answerNeverStarted(3, sentAt - 60_000, sentAt, sentAt + 10_000), false);
  // An answer request did start after the send: it is on its way.
  assert.equal(answerNeverStarted(3, sentAt + 400, sentAt, sentAt + 60_000), false);
  // A watcher that has never seen one proves nothing, and must not fail every send.
  assert.equal(answerNeverStarted(0, 0, sentAt, sentAt + 60_000), false);
});

const { rateWaitMs, DEEPSEEK_SENDS_PER_WINDOW, DEEPSEEK_WINDOW_MS } = require("../dist/providers/deepseek/browser");

test("DeepSeek's rate is kept: the tenth send in a minute waits, the ninth does not", () => {
  // Measured: the eleventh message within about a minute is taken and never
  // answered. OnFlip keeps under it with a margin, nine per sixty-five seconds.
  assert.equal(DEEPSEEK_SENDS_PER_WINDOW, 9);
  const now = 1_000_000;
  const every4s = (n) => Array.from({ length: n }, (_, i) => now - (n - i) * 4_000);
  assert.equal(rateWaitMs(every4s(8), now), 0);
  // Nine in the window: the next waits until the oldest of them ages out.
  const nine = every4s(9);
  assert.equal(rateWaitMs(nine, now), nine[0] + DEEPSEEK_WINDOW_MS - now);
  assert.ok(rateWaitMs(nine, now) > 0 && rateWaitMs(nine, now) <= DEEPSEEK_WINDOW_MS);
  // Sends older than the window do not count.
  assert.equal(rateWaitMs([...every4s(3), now - 70_000, now - 90_000, now - 200_000], now), 0);
});

test("a slow session never waits", () => {
  const now = 1_000_000;
  const every8s = Array.from({ length: 30 }, (_, i) => now - (30 - i) * 8_000);
  assert.equal(rateWaitMs(every8s, now), 0);
});

test("a stopped turn does not sit out DeepSeek's rate", { timeout: 10_000 }, async () => {
  // The same trap `paceSend` fell into: an abort that has already happened
  // never fires its event, and the wait ran its full course.
  const { keepToRate } = require("../dist/providers/deepseek/browser");
  for (let i = 0; i < DEEPSEEK_SENDS_PER_WINDOW; i++) await keepToRate();
  const stopped = new AbortController();
  stopped.abort();
  let began = Date.now();
  await assert.rejects(keepToRate(stopped.signal), (e) => e.code === "interrupted");
  assert.ok(Date.now() - began < 1_000, `waited ${Date.now() - began}ms after the stop`);
  const stopping = new AbortController();
  began = Date.now();
  setTimeout(() => stopping.abort(), 50);
  await assert.rejects(keepToRate(stopping.signal), (e) => e.code === "interrupted");
  assert.ok(Date.now() - began < 1_000, `waited ${Date.now() - began}ms after the stop`);
});
