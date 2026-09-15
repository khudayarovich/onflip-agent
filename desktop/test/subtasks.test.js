"use strict";

/**
 * Seeing what a sub-agent did, without putting it in the conversation.
 *
 * OnFlip can hand a self-contained piece of work to a second agent with its
 * own conversation — the case for it is work that reads a great deal and
 * concludes a little, where the parent would otherwise end up carrying
 * thirty file listings it will never need again.
 *
 * Keeping those tool calls out of the transcript is right and stays. What
 * was wrong is that it left them nowhere at all: a notice saying a sub-task
 * had begun, a pause of unknown length, then an answer — with no way to see
 * what it was doing, whether it was doing anything, or what it had done.
 *
 * These are source-level checks, and weak ones by nature: the recording
 * lives inside the engine's sub-agent runner, which needs half an app around
 * it to build. What they pin is that the wiring is still connected, which is
 * the part that breaks silently — a dropped `onToolEnd` would leave a panel
 * that works, updates, and is always empty.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ENGINE = fs.readFileSync(path.join(__dirname, "..", "engine", "engine.ts"), "utf8");
const HOST = fs.readFileSync(path.join(__dirname, "..", "engine", "host.ts"), "utf8");
const PROTOCOL = fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.ts"), "utf8");
const SIDEBAR = fs.readFileSync(
  path.join(__dirname, "..", "ui", "src", "components", "Sidebar.tsx"),
  "utf8"
);

/** The engine's sub-agent runner, which is where all of this is wired. */
function runner() {
  const from = ENGINE.indexOf("private async runSubAgent(");
  assert.ok(from > 0, "runSubAgent has been renamed or removed");
  return ENGINE.slice(from, ENGINE.indexOf("\n  private agentOptions(", from));
}

test("a sub-task is recorded when it starts, not only when it ends", () => {
  // The panel exists for the question "is anything happening", so a record
  // that appears only on completion would answer it exactly when it has
  // stopped mattering.
  const body = runner();

  assert.match(body, /status: "running"/);
  assert.match(body, /this\.subTasks\.push\(record\)/);
  assert.match(body, /this\.pushSubTasks\(\)/);
});

test("what it does is captured as it does it", () => {
  // `onToolEnd` on the child's own run: the sub-agent's tool calls, recorded
  // against its record instead of emitted into the parent's transcript.
  const body = runner();

  assert.match(body, /onToolEnd: \(call, toolResult\) =>/);
  assert.match(body, /tool: call\.tool/);
  assert.match(body, /subject: subjectFor\(call\.tool, call\.arguments\)/);
  assert.match(body, /ok: !toolResult\.error/);
});

test("the activity list is capped, because this is a summary", () => {
  // A sub-agent that ran fifty greps should say so rather than list them,
  // and the record is held in memory for the life of the session.
  const body = runner();

  assert.match(body, /record\.activity\.length < SUB_TASK_ACTIVITY_MAX/);
  assert.match(ENGINE, /const SUB_TASK_ACTIVITY_MAX = \d+;/);
});

test("every way it can end is recorded, including the ways nobody plans for", () => {
  // Done, interrupted, and thrown. A record left saying "running" for ever
  // because the runner threw is worse than no panel: it reports work that
  // is not happening.
  const body = runner();

  assert.match(body, /record\.status = result\.interrupted \? "stopped" : "done"/);
  assert.match(body, /record\.status = "failed"/);
  assert.match(body, /record\.endedAt = Date\.now\(\)/);
  assert.match(body, /catch \(e\) \{/);
});

test("the window can ask for the list, and is told when it changes", () => {
  assert.match(ENGINE, /listSubTasks\(\): SubTaskDTO\[\]/);
  assert.match(ENGINE, /this\.peer\.emit\("sub-tasks"/);
  assert.match(HOST, /case "listSubTasks":/);
  assert.match(PROTOCOL, /listSubTasks: \{ params: Record<string, never>; result: SubTaskDTO\[\] \}/);
});

test("and there is a way in to it", () => {
  // A panel nothing opens is a panel nobody sees.
  assert.match(SIDEBAR, /onOpenSubTasks\(\)/);
  assert.match(SIDEBAR, /menuSubTasks/);
});

test("sub-agents can be turned off, and then the tool is absent", () => {
  // Not refused — absent. A tool the model can call and nothing can carry
  // out is worse than no tool: it will try, be told no, and try again.
  // `taskTools` already builds nothing when there is no runner, so the
  // setting works by withholding the runner rather than by adding a refusal.
  assert.match(ENGINE, /loadConfig\(\)\.subAgents === false \? undefined : \(req\) => this\.runSubAgent\(req\)/);
});

test("and the setting reaches the window, defaulting to on", () => {
  const settings = fs.readFileSync(
    path.join(__dirname, "..", "ui", "src", "components", "SettingsModal.tsx"),
    "utf8"
  );
  assert.match(ENGINE, /subAgents: cfg\.subAgents !== false/);
  assert.match(ENGINE, /subAgents: \(v\) => \(\{ subAgents: Boolean\(v\) \}\)/);
  assert.match(settings, /config\?\.subAgents \?\? true/);
});
