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

test("a line that starts with a path is a message, not an unknown command", { skip: needsBuild }, () => {
  // "/api/login returns 500" was cleared from the composer and answered
  // "Unknown command" — the most natural start of a bug report, thrown away.
  const { slashDecision } = require(MODULE);
  const names = SLASH_COMMANDS.map((c) => c.name);
  assert.deepEqual(slashDecision("/api/login returns 500", names), { kind: "message" });
  assert.deepEqual(slashDecision("/etc/hosts is wrong", names), { kind: "message" });
  assert.deepEqual(slashDecision("/tmp is full again", names), { kind: "message" });
  assert.deepEqual(slashDecision("fix /api/login", names), { kind: "message" });
  // A path on its own too: it is not a word a command could be.
  assert.deepEqual(slashDecision("/etc/hosts", names), { kind: "message" });
});

test("commands still run, and a lone mistyped one is reported, not sent", { skip: needsBuild }, () => {
  // The false-positive half.
  const { slashDecision } = require(MODULE);
  const names = SLASH_COMMANDS.map((c) => c.name);
  assert.deepEqual(slashDecision("/new", names), { kind: "run", name: "/new", arg: "" });
  assert.deepEqual(slashDecision("/cwd src", names), { kind: "run", name: "/cwd", arg: "src" });
  assert.deepEqual(slashDecision("/zzz", names), { kind: "unknown", name: "/zzz" });
  const shared = names.filter((n) => n.startsWith("/c"));
  if (shared.length > 1) assert.equal(slashDecision("/c", names).kind, "ambiguous");
});

test("the composer asks the decision, and keeps an unknown command's text", { skip: needsBuild }, () => {
  const composer = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "components", "Composer.tsx"), "utf8");
  assert.match(composer, /const decision = slashDecision\(value, commands\.map\(\(c\) => c\.name\)\);/);
  assert.match(composer, /if \(decision\.kind === "unknown"\) \{\s*onNotice\(`Unknown command: \$\{decision\.name\}`\);\s*return;\s*\}/);
});
