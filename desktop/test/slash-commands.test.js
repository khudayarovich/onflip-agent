"use strict";

/**
 * Which slash commands each service offers.
 *
 * Reported from DeepSeek mode: the "/" menu listed ChatGPT's commands. Two of
 * them cannot work there at all — DeepSeek has no projects, and OnFlip cannot
 * reopen a DeepSeek thread it did not start, so the seam answers both with
 * nothing — and a third described four reasoning levels where the page has a
 * single switch.
 *
 * The rule: a command is offered when the active service can carry it out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MODULE = path.join(__dirname, "..", "dist", "shared", "commands.js");
const needsBuild = fs.existsSync(MODULE)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const { SLASH_COMMANDS, slashCommands } = needsBuild ? {} : require(MODULE);
const names = (list) => list.map((c) => c.name);

test("ChatGPT gets the whole list, exactly as before", { skip: needsBuild }, () => {
  assert.deepEqual(slashCommands("chatgpt"), SLASH_COMMANDS);
  assert.deepEqual(slashCommands(undefined), SLASH_COMMANDS, "and so does an unknown provider");
});

test("DeepSeek is not offered what it cannot do", { skip: needsBuild }, () => {
  const offered = names(slashCommands("deepseek"));
  assert.ok(!offered.includes("/project"), "DeepSeek has no projects");
  assert.ok(!offered.includes("/chats"), "and no conversations OnFlip can reopen");
});

test("but keeps everything that works the same on both", { skip: needsBuild }, () => {
  const offered = names(slashCommands("deepseek"));
  for (const name of ["/new", "/model", "/compact", "/diff", "/undo", "/settings"]) {
    assert.ok(offered.includes(name), `${name} works on either service`);
  }
});

test("and /thinking describes the switch DeepSeek actually has", { skip: needsBuild }, () => {
  const thinking = slashCommands("deepseek").find((c) => c.name === "/thinking");
  assert.ok(thinking, "still offered — DeepThink is a real control");
  assert.match(thinking.description, /DeepThink/);
  assert.ok(!/medium/.test(thinking.description), "no levels that do not exist there");
});

test("filtering one service does not edit the list the other reads", { skip: needsBuild }, () => {
  slashCommands("deepseek");
  const chatgpt = slashCommands("chatgpt").find((c) => c.name === "/thinking");
  assert.match(chatgpt.description, /medium/, "ChatGPT's four levels are untouched");
  assert.ok(names(slashCommands("chatgpt")).includes("/project"));
});
