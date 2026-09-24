"use strict";

/**
 * A reply size to stay under, said only where one has been measured.
 *
 * On a Free account a reply carrying four whole files was cut off at 13,336
 * characters, mid-stylesheet, and the game shipped without its board styles.
 * The rationed plans are told to keep replies under 10,000 characters; the
 * paid ones are told nothing, because nothing there has been measured and a
 * limit nobody hits would only cost round trips.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSystemPrompt } = require("../dist/agent/system");
const { replyLimitFor, RATIONED_REPLY_LIMIT_CHARS } = require("../dist/chatgpt/plans");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-reply-limit-"));
const base = {
  tools: [],
  context: { instructions: "", instructionSources: [], environment: "", skills: [], cwd },
  approvalMode: "ask",
  shellEnabled: true,
};

test("the rationed plans get a reply limit and the others do not", () => {
  assert.equal(replyLimitFor("free"), RATIONED_REPLY_LIMIT_CHARS);
  assert.equal(replyLimitFor("chatgptgoplan"), RATIONED_REPLY_LIMIT_CHARS);
  for (const plan of ["plus", "prolite", "pro", undefined]) assert.equal(replyLimitFor(plan), undefined, String(plan));
});

test("the prompt carries the limit only when it is given one", () => {
  const limited = buildSystemPrompt({ ...base, replyLimitChars: 10_000 });
  assert.match(limited, /Keep every reply under about 10,000 characters/);
  assert.doesNotMatch(buildSystemPrompt(base), /Keep every reply under/);
});

test("an empty folder gets a page that opens without a build", () => {
  // Run A of the Free-account test chose React and Vite for a small game:
  // npm install and three builds, each one an approval in "ask" mode.
  assert.match(buildSystemPrompt(base), /In an empty folder, a small page, tool or game is plain HTML, CSS and JavaScript/);
});
