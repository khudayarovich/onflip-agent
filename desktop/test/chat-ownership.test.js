"use strict";

/**
 * Only the chats a session opened are deleted with it.
 *
 * Deleting a session deletes the ChatGPT conversations recorded in its
 * `chatIds`. Two kinds of conversation were being recorded that it does not
 * own: the user's own chat, attached with "continue this chat", which the
 * driver reports as the current conversation after every turn; and every
 * chat earlier sessions in the same window had opened, because the driver's
 * list of opened conversations spans the whole process.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "engine", "chat-ids.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

test("an attached chat is never recorded as the session's own", { skip: needsBuild }, () => {
  const { recordableChatIds } = require(DIST);
  assert.deepEqual(recordableChatIds([], ["users-own-chat"], new Set(), "users-own-chat"), []);
});

test("and one recorded by an older build is dropped from the record", { skip: needsBuild }, () => {
  const { recordableChatIds } = require(DIST);
  assert.deepEqual(recordableChatIds(["users-own-chat", "opened-1"], [], new Set(), "users-own-chat"), ["opened-1"]);
});

test("chats other sessions opened earlier in the window are not inherited", { skip: needsBuild }, () => {
  const { recordableChatIds } = require(DIST);
  const seenBefore = new Set(["another-sessions-chat"]);
  assert.deepEqual(
    recordableChatIds([], ["another-sessions-chat", "opened-this-turn"], seenBefore, undefined),
    ["opened-this-turn"]
  );
});

test("the session's own chats accumulate across turns, once each", { skip: needsBuild }, () => {
  const { recordableChatIds } = require(DIST);
  let record = recordableChatIds([], ["a"], new Set(), undefined);
  record = recordableChatIds(record, ["a", "b"], new Set(["a"]), undefined);
  assert.deepEqual(record, ["a", "b"]);
});

test("the engine records through the rule and deletes around the attached chat", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "engine", "engine.ts"), "utf8");
  assert.match(source, /recordableChatIds\(/);
  assert.match(source, /\.filter\(\(chat\) => chat !== stored\?\.chatId\)/, "removeSession spares the attached chat");
});
