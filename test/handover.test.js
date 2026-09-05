"use strict";

/**
 * What survives a compaction, and what the model is told about its own jobs.
 *
 * Both of these come from the same captured session. A turn compacted
 * mid-flight; after that the model was working from a brief it had written
 * itself, and two things it needed were no longer anywhere in the context:
 * the user's request in the user's own words, and whether the background
 * server it had started was still alive.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { lastUserRequest } = require("../dist/agent/run");
const { backgroundJobLine, turnReminder } = require("../dist/agent/system");

const said = (role, content, extra = {}) => ({ id: role + content, role, content, ...extra });

// --- what the user actually asked ------------------------------------------

test("the newest real request wins over an older one", () => {
  const history = [
    said("system", "the prompt"),
    said("user", "build the game"),
    said("assistant", "done"),
    said("user", "can we change the mouse to some knife shaped mouse?"),
  ];

  assert.equal(lastUserRequest(history), "can we change the mouse to some knife shaped mouse?");
});

test("a tool result is not the user talking", () => {
  const history = [
    said("user", "make the cursor a knife"),
    said("assistant", "reading"),
    said("user", '<onflip:result tool="read">\n  1| canvas {\n</onflip:result>', {
      toolName: "read",
    }),
  ];

  assert.equal(lastUserRequest(history), "make the cursor a knife");
});

test("a protocol nudge is not the user talking", () => {
  const history = [
    said("user", "make the cursor a knife"),
    said("assistant", "I'll verify the build now"),
    said("user", "[OnFlip protocol error — automated message; do not answer it conversationally]"),
  ];

  assert.equal(lastUserRequest(history), "make the cursor a knife");
});

test("an earlier handover is not mistaken for a request", () => {
  // Otherwise the second compaction of a session carries the first
  // compaction's brief forward as though the user had written it.
  const history = [
    said("user", "make the cursor a knife"),
    said("user", "[Context carried over from the earlier part of this session]\n\nnotes"),
  ];

  assert.equal(lastUserRequest(history), "make the cursor a knife");
});

test("a session with nothing but machinery in it reports nothing", () => {
  const history = [said("system", "the prompt"), said("user", "[OnFlip protocol reminder]")];

  assert.equal(lastUserRequest(history), null);
});

test("a pasted wall of text is cut rather than replacing the brief", () => {
  const history = [said("user", "x".repeat(5_000))];
  const kept = lastUserRequest(history, 100);

  assert.ok(kept.length < 200, `kept ${kept.length} characters`);
  assert.ok(kept.startsWith("x".repeat(100)));
  assert.match(kept, /truncated/);
});

// --- what happened to the background jobs ----------------------------------

test("no jobs means nothing is said about jobs", () => {
  assert.equal(backgroundJobLine(), "");
  assert.equal(backgroundJobLine([]), "");
});

test("a job that has exited is named as gone, not merely listed", () => {
  const line = backgroundJobLine([
    { id: "job_2", command: "node -e \"require('http').createServer()\"", running: false },
  ]);

  assert.match(line, /job_2/);
  assert.match(line, /exited/);
  // The whole point: the model has to be told the port is dead, because the
  // tool result that started the job still says it came up fine.
  assert.match(line, /Start it again/);
});

test("a still-running job is not described as dead", () => {
  const line = backgroundJobLine([{ id: "job_1", command: "npm run dev", running: true }]);

  assert.match(line, /job_1 `npm run dev` — running/);
  assert.doesNotMatch(line, /Start it again/);
});

test("a long command is shortened so the reminder stays cheap", () => {
  const line = backgroundJobLine([
    { id: "job_1", command: "node ".repeat(80), running: true },
  ]);

  assert.ok(line.length < 200, `reminder line was ${line.length} characters`);
  assert.match(line, /…/);
});

test("the reminder carries the jobs, and drops them when the shell is off", () => {
  const jobs = [{ id: "job_2", command: "node server.js", running: false }];

  assert.match(turnReminder(true, ["bash"], jobs), /job_2/);
  // Nothing can be restarted without a shell, so the advice would be noise.
  assert.doesNotMatch(turnReminder(false, ["bash"], jobs), /job_2/);
  assert.doesNotMatch(turnReminder(true, ["bash"]), /Background jobs/);
});
