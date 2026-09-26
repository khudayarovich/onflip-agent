"use strict";

/**
 * The window's engine checks the work before it takes a `done`.
 *
 * The rule lives in the core (`own-check.ts`, tested there); this is the
 * wiring: the engine turns it on for its own turns, off for a sub-task's
 * (checked once, at the parent's `done`), and off entirely when the config
 * says `checkBeforeDone: false`. And the check reaches the window the way
 * any command does — as a tool card — so the person sees what ran.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-check-before-done-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const ROOT = path.join(__dirname, "..", "..");
const ENGINE = path.join(__dirname, "..", "dist", "engine", "engine.js");
const needsBuild = fs.existsSync(ENGINE) ? false : "desktop/dist is not built";

const DONE = "````onflip\ntool: done\nsummary: |\n  Changed app.js.\n````";
const WRITE = "```onflip\ntool: write\npath: app.js\ncontent: |\n  module.exports = 'BUG';\n```";

function engineWith(replies) {
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  providers.closeBrowser = async () => {};
  const { notePassedCommand } = require(path.join(ROOT, "dist", "agent", "project-checks.js"));
  const { resetShellCwd } = require(path.join(ROOT, "dist", "tools", "shell.js"));
  const { Engine } = require(ENGINE);
  resetShellCwd();
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  fs.writeFileSync(path.join(work, "app.js"), "module.exports = 1;\n");
  fs.writeFileSync(
    path.join(work, "app.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst fs = require("node:fs");\n' +
      'test("no BUG", () => assert.ok(!fs.readFileSync(__dirname + "/app.js", "utf8").includes("BUG")));\n'
  );
  notePassedCommand({ project: work, line: "node --test", startDir: work, ms: 900 });
  const events = [];
  const engine = new Engine({ emit: (event, data) => events.push({ event, data }), request: async () => ({ allow: true }) }, work);
  const sent = [];
  engine.transport = {
    name: "api",
    async send(history) {
      sent.push(history[history.length - 1].content);
      return { content: replies.shift() ?? DONE, conversationId: null };
    },
    reset() {},
  };
  engine.connected = true;
  engine.history = [];
  engine.archived = [];
  // The engine's own policy, not a hand-made one: approving a write needs
  // the project folder it is judged against.
  const { createPolicy } = require(path.join(ROOT, "dist", "agent", "permissions.js"));
  engine.policy = createPolicy(work, "yolo", {});
  engine.context = { instructionSources: [], environment: "", instructions: "", skills: [], cwd: work };
  const items = () => events.filter((e) => e.event === "item").map((e) => e.data);
  const updates = () => events.filter((e) => e.event === "tool-update").map((e) => e.data);
  return { engine, items, updates, sent };
}

async function idle(engine) {
  do await new Promise((r) => setTimeout(r, 50));
  while (engine.busy);
}

test("the engine's turn checks the change, and the window sees the check as a command", { skip: needsBuild, timeout: 60_000 }, async () => {
  const { engine, items, updates, sent } = engineWith([
    WRITE,
    DONE,
    "```onflip\ntool: write\npath: app.js\ncontent: |\n  module.exports = 2;\n```",
    DONE,
  ]);
  engine.send("change app.js");
  await idle(engine);
  const checks = items().filter((i) => i.type === "tool" && i.call.tool === "bash");
  assert.equal(checks.length, 2, JSON.stringify(items().map((i) => i.type)));
  assert.equal(checks[0].call.subject, "node --test");
  // Each card's outcome arrives as its update, as any command's does.
  const outcome = (card) => updates().find((u) => u.id === card.id)?.result;
  assert.equal(outcome(checks[0]).error, true, "the first run caught the BUG");
  assert.equal(outcome(checks[1]).error, false, "and the second passed the fix");
  assert.match(sent[2], /OnFlip ran this project's own check/);
  assert.ok(items().some((i) => i.type === "notice" && /checked the work before finishing: `node --test` passed/.test(i.text)));
});

test("switched off in the config, nothing is run", { skip: needsBuild, timeout: 60_000 }, async () => {
  const { engine, items } = engineWith([WRITE, DONE]);
  engine.config = { ...engine.config, checkBeforeDone: false };
  engine.send("change app.js");
  await idle(engine);
  assert.equal(items().filter((i) => i.type === "tool" && i.call.tool === "bash").length, 0);
  assert.ok(items().some((i) => i.type === "assistant" && /Changed app\.js\./.test(i.text)));
});

test("a sub-task's turn leaves the check to its parent", { skip: needsBuild }, () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "engine", "engine.ts"), "utf8");
  assert.match(source, /checkBeforeDone: this\.config\.checkBeforeDone !== false/);
  assert.match(source, /signal: req\.signal,\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*checkBeforeDone: false,/);
});
