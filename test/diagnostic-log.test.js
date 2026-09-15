"use strict";

/**
 * The log tail that goes into a diagnostics paste.
 *
 * Diagnosing a fault on somebody else's machine used to mean asking them to
 * run a shell command and send back the result — a lot to ask, easy to get
 * wrong, and a round trip for every question. The report already named the
 * log file; this puts the part that matters inside it.
 *
 * Which makes what it leaves out the important half. A diagnostics blob is
 * pasted into an issue, a chat, an email — somewhere it outlives the moment —
 * and the log it is drawn from carries whatever each writer thought useful,
 * including the person's own words: `session` records a turn with its text,
 * tools record output, the transport records replies.
 *
 * So the filter is an allow-list. Anything not named is dropped, including
 * fields that do not exist yet, which is the only version of this rule that
 * stays true as the logging grows.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { diagnosticLogLines } = require("../dist/log");

const LOG = [
  JSON.stringify({
    at: "2026-09-15T13:40:15.960Z",
    level: "info",
    scope: "session",
    msg: "user turn",
    data: { text: "my password is hunter2, please rotate the key in prod" },
  }),
  JSON.stringify({
    at: "2026-09-15T13:40:18.352Z",
    level: "info",
    scope: "qwen",
    msg: "turn: opening the page",
    data: { chars: 26063 },
  }),
  JSON.stringify({
    at: "2026-09-15T13:40:23.505Z",
    level: "warn",
    scope: "qwen",
    msg: "a guest conversation on a live session; reloading once",
    data: { url: "https://chat.qwen.ai/c/guest" },
  }),
  JSON.stringify({
    at: "2026-09-15T13:40:31.000Z",
    level: "info",
    scope: "deepseek",
    msg: "opening the browser",
    data: { headed: false },
  }),
  "{ this line is torn",
].join("\n");

test("the private half of a log line never reaches the paste", () => {
  // `session` logs a turn with the text of it. The line is worth having —
  // it says a turn started — and its content is not ours to circulate.
  const lines = diagnosticLogLines(LOG, ["qwen", "session"]).join("\n");

  assert.match(lines, /user turn/);
  assert.ok(!/hunter2/.test(lines), "the prompt text is in the diagnostics blob");
  assert.ok(!/rotate the key/.test(lines), "the prompt text is in the diagnostics blob");
});

test("a field nobody has allowed is dropped, even a harmless-looking one", () => {
  // The rule has to hold for fields that do not exist yet, or it decays into
  // a deny-list of the leaks somebody already thought of.
  const line = JSON.stringify({
    at: "2026-09-15T13:40:00.000Z",
    level: "info",
    scope: "qwen",
    msg: "something",
    data: { url: "https://chat.qwen.ai/", answer: "the model's reply", somethingNew: "surprise" },
  });
  const out = diagnosticLogLines(line, ["qwen"]).join("\n");

  assert.match(out, /url=https:\/\/chat\.qwen\.ai\//);
  assert.ok(!/the model's reply/.test(out));
  assert.ok(!/surprise/.test(out));
});

test("what is kept is what answers 'what did the driver see'", () => {
  const lines = diagnosticLogLines(LOG, ["qwen", "session"]);

  assert.ok(lines.some((l) => /guest conversation/.test(l) && /c\/guest/.test(l)));
  assert.ok(lines.some((l) => /13:40:23 W qwen/.test(l)), lines.join(" | "));
});

test("only the scopes asked for", () => {
  const out = diagnosticLogLines(LOG, ["qwen"]).join("\n");

  assert.ok(!/deepseek/.test(out));
  assert.ok(!/user turn/.test(out));
});

test("a torn last line does not take the report down with it", () => {
  // The log is append-only and may be mid-write. Throwing here would mean a
  // diagnostics paste that fails exactly when something is wrong.
  assert.doesNotThrow(() => diagnosticLogLines(LOG, ["qwen"]));
  assert.doesNotThrow(() => diagnosticLogLines("", ["qwen"]));
  assert.doesNotThrow(() => diagnosticLogLines(undefined, ["qwen"]));
});

test("it is a tail, not the whole log", () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({ at: "2026-09-15T13:40:00.000Z", scope: "qwen", msg: `line ${i}` })
  ).join("\n");

  const out = diagnosticLogLines(many, ["qwen"], 40);
  assert.equal(out.length, 40);
  assert.match(out[out.length - 1], /line 199/);
});
