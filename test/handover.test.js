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
const { backgroundJobLine, languageAnchor, turnReminder } = require("../dist/agent/system");

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

// --- which language to answer in -------------------------------------------

test("the request is quoted back, so the instruction has something to point at", () => {
  // "Write in the language the user writes in" has no referent once a session
  // has drifted: the model looks at the conversation, sees its own last
  // twenty replies in the wrong language, and matches those.
  const line = languageAnchor("fix knife position with the dot cutting");

  assert.match(line, /fix knife position with the dot cutting/);
  assert.match(line, /that language/);
});

test("only the first line is quoted, and a long one is cut", () => {
  const anchor = languageAnchor(`${"x".repeat(400)}\nsecond line`);

  // The quote is what a long request can blow up, so that is what is capped.
  const quoted = /"([^"]*)"/.exec(anchor)?.[1] ?? "";
  assert.ok(quoted.length <= 121, `quote was ${quoted.length} characters`);
  assert.ok(anchor.length < 450, `anchor was ${anchor.length} characters`);
  assert.ok(!anchor.includes("second line"));
});

test("a message with no Cyrillic rules Russian out by name", () => {
  // Quoting alone lost to the account's own language preference: reproduced
  // on a fresh session, one English sentence in and a Russian answer out.
  const anchor = languageAnchor("can you check my pc storage?");

  assert.match(anchor, /not Russian/);
  assert.match(anchor, /do not answer in Russian/);
});

test("and a Russian one is told to stay in Russian", () => {
  const anchor = languageAnchor("проверь моё хранилище");

  assert.match(anchor, /answer in Russian/);
  assert.ok(!/do not answer in Russian/.test(anchor));
});

test("Uzbek is not mistaken for English, only ruled out of Russian", () => {
  // Script is all that can be decided without guessing. Latin covers both
  // English and Uzbek, so the quote carries the rest.
  const anchor = languageAnchor("kompyuterimdagi joyni tekshirib bera olasanmi?");

  assert.match(anchor, /kompyuterimdagi/);
  assert.match(anchor, /not Russian/);
  assert.ok(!/English/.test(anchor), "it must not claim the message is English");
});

test("a request that opens with a blank line still finds its words", () => {
  assert.match(languageAnchor("\n\n  сделай тёмную тему  "), /сделай тёмную тему/);
});

test("no request means the general instruction is used instead", () => {
  assert.equal(languageAnchor(), "");
  assert.equal(languageAnchor(null), "");
  assert.equal(languageAnchor("   "), "");
  // The reminder must still say something about language either way.
  assert.match(turnReminder(true, ["bash"]), /language the user writes in/);
});

test("the reminder anchors on the request when there is one", () => {
  const reminder = turnReminder(true, ["bash"], [], "make the cursor a knife");

  assert.match(reminder, /make the cursor a knife/);
  // Replaced, not added: two instructions about language is one too many.
  assert.doesNotMatch(reminder, /language the user writes in/);
});

test("the reminder carries the jobs, and drops them when the shell is off", () => {
  const jobs = [{ id: "job_2", command: "node server.js", running: false }];

  assert.match(turnReminder(true, ["bash"], jobs), /job_2/);
  // Nothing can be restarted without a shell, so the advice would be noise.
  assert.doesNotMatch(turnReminder(false, ["bash"], jobs), /job_2/);
  assert.doesNotMatch(turnReminder(true, ["bash"]), /Background jobs/);
});

// --- where the person asking actually is ------------------------------------

test("a turn from Telegram says the person is not at the machine", () => {
  // Reported from a real session: asked over Telegram to send a file, the
  // agent saved it and answered with its path. Right for someone at the
  // keyboard, useless to someone holding a phone — they had to ask twice.
  const reminder = turnReminder(true, ["bash", "read", "send_file"], [], "send me the report", true);

  assert.match(reminder, /came from Telegram/);
  assert.match(reminder, /send_file/);
  assert.match(reminder, /not delivering it/);
});

test("and when nothing can carry a file, it says that instead of naming a tool", () => {
  const reminder = turnReminder(true, ["bash", "read"], [], "send me the report", true);

  assert.match(reminder, /no way to hand them a file/);
  assert.ok(!/goes to them with send_file/.test(reminder));
});

test("a turn from the desktop says nothing about Telegram at all", () => {
  const reminder = turnReminder(true, ["bash", "send_file"], [], "send me the report", false);

  assert.ok(!/came from Telegram/.test(reminder));
  // The default reminder is otherwise unchanged.
  assert.match(reminder, /OnFlip protocol reminder/);
});
