"use strict";

/**
 * How long each turn took, recovered from a stored session.
 *
 * The live turn already showed "Worked for 4m" when it finished, but that
 * line lived in the renderer's own state — reopen the session and every one
 * of them was gone, so the record of how long anything took survived exactly
 * as long as the window did.
 *
 * Nothing new is written to disk for this. The store has always stamped each
 * message with `createdAt`, so the gap between a request and the last message
 * answering it is the turn — which means these lines come back for sessions
 * recorded long before the feature existed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "engine", "replay.js");
// The engine CI job builds src/ and not the desktop app, and the root runner
// discovers every *.test.js in the repository. Sitting out beats a red build
// that only means "the other package is not compiled".
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const MINUTE = 60_000;
let clock = Date.UTC(2026, 8, 6, 12, 0, 0);

/** A message at an explicit offset from the previous one. */
function at(role, content, gapMs = 0, extra = {}) {
  clock += gapMs;
  return { id: `${role}-${clock}`, role, content, createdAt: clock, ...extra };
}

const durations = (items) => items.filter((i) => i.type === "duration").map((i) => i.ms);

test("a finished turn reports the time from request to last word", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const history = [
    { id: "s", role: "system", content: "prompt", createdAt: clock },
    at("user", "make the cursor a knife"),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  Changed it.\n```", 4 * MINUTE),
  ];

  assert.deepEqual(durations(replayItems(history)), [4 * MINUTE]);
});

test("every turn in a session gets its own line", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const history = [
    at("user", "build the game"),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  Built.\n```", 9 * MINUTE),
    at("user", "now the cursor", 30 * MINUTE),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  Done.\n```", 2 * MINUTE),
  ];

  // Thirty minutes of the user being away is not work, and is not counted.
  assert.deepEqual(durations(replayItems(history)), [9 * MINUTE, 2 * MINUTE]);
});

test("the line lands after the turn it measures", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const history = [
    at("user", "first"),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  One.\n```", 3 * MINUTE),
    at("user", "second", MINUTE),
  ];
  const kinds = replayItems(history).map((i) => i.type);

  assert.deepEqual(kinds, ["user", "assistant", "duration", "user"]);
});

test("tool work counts toward the turn", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const history = [
    at("user", "check the build"),
    at("assistant", "```onflip\ntool: bash\ncommand: npm test\n```", MINUTE),
    at("user", '<onflip:result tool="bash">\nok\n</onflip:result>', 5 * MINUTE, {
      toolName: "bash",
    }),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  Passing.\n```", MINUTE),
  ];

  assert.deepEqual(durations(replayItems(history)), [7 * MINUTE]);
});

test("a compaction note does not start a new turn", { skip: needsBuild }, () => {
  // It rides the user role but the user did not write it, so counting it as
  // a request would cut one turn into two and lose the time before it.
  const { replayItems } = require(DIST);
  const history = [
    at("user", "do the thing"),
    at("assistant", "working", 2 * MINUTE),
    at("user", "[Context carried over from the earlier part of this session]\n\nnotes", MINUTE),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  Done.\n```", 3 * MINUTE),
  ];

  assert.deepEqual(durations(replayItems(history)), [6 * MINUTE]);
});

test("a request nobody answered has no duration", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  assert.deepEqual(durations(replayItems([at("user", "hello?")])), []);
});

test("a sub-second turn is left off as noise", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const history = [
    at("user", "hi"),
    at("assistant", "```onflip\ntool: done\nsummary: |\n  Hello.\n```", 300),
  ];

  assert.deepEqual(durations(replayItems(history)), []);
});

test("a session recorded before timestamps existed shows nothing", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const history = [
    { id: "a", role: "user", content: "old session" },
    { id: "b", role: "assistant", content: "```onflip\ntool: done\nsummary: |\n  Old.\n```" },
  ];

  assert.deepEqual(durations(replayItems(history)), []);
});
