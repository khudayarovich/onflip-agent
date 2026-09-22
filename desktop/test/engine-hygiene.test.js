"use strict";

/**
 * Two small ways the engine mishandled what it was given.
 *
 * - A skill's `{input}` was filled with String.replace and a string, which
 *   expands `$&`, `$'` and `$$` in the user's own words: `printf $'a b'`
 *   lost the text and put the skill's instructions in twice.
 * - The session lock's folder was created unguarded, out of the save a turn
 *   makes before it starts; a failure there escaped the turn's own handling
 *   and left the engine marked busy for good.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SKILLS = path.join(__dirname, "..", "dist", "shared", "skills.js");
const LOCK = path.join(__dirname, "..", "dist", "engine", "session-lock.js");
const needsBuild = fs.existsSync(SKILLS) && fs.existsSync(LOCK)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-hygiene-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");

test("a skill takes the user's words literally, dollar signs and all", { skip: needsBuild }, () => {
  const { expandSkillToken } = require(SKILLS);
  const words = "printf $'a b' and keep $& and $$ as typed";
  const expanded = expandSkillToken(`@skill:fix-bug ${words}`);
  assert.ok(expanded.includes(words), expanded.slice(0, 200));
  assert.equal(expanded.split("Reproduce it first").length - 1, 1, "the instructions appear once");
});

test("a lock folder that cannot be made is 'not ours', not a crash", { skip: needsBuild }, () => {
  const { claimSessionLock, sessionLockFile } = require(LOCK);
  const dir = path.dirname(sessionLockFile("x"));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "a file where the folder should be");
  assert.equal(claimSessionLock("some-session"), false);
});
