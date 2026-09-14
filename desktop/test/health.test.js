"use strict";

/**
 * Reading the app's own run back out of its logs.
 *
 * Every event this counts has been written since the first release, and for
 * weeks nobody read them. A hand measurement of one machine's twenty-one
 * session logs found 21% of all tool calls failing, `edit` failing half the
 * time and `multi_edit` failing on all nine of its calls — each one a
 * well-formed request the call parser could not read. None of that was
 * visible anywhere in the app.
 *
 * These tests are about the counting being trustworthy, because a health
 * panel that is wrong is worse than none: it would be believed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const DIST = path.join(__dirname, "..", "dist", "engine", "health.js");
// The engine's CI job builds src/ and not the desktop app, and the root
// runner discovers every *.test.js in the repository - so this file has to
// be able to sit out rather than fail.
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const load = () => require(DIST).readHealth;

/** A log directory holding one session file made of these events. */
function logs(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-health-"));
  const now = new Date().toISOString();
  const lines = events.map((e) => JSON.stringify({ at: e.at ?? now, level: "info", scope: "tool", ...e }));
  fs.writeFileSync(path.join(dir, "20260914120000-aaaaaaaa.jsonl"), lines.join("\n") + "\n");
  return dir;
}

test("a tool's calls and failures are counted from its own done lines", { skip: needsBuild }, () => {
  const readHealth = load();
  const report = readHealth(
    14,
    logs([
      { msg: "done edit", data: { error: false } },
      { msg: "done edit", data: { error: true } },
      { msg: "done edit", data: { error: true } },
      { msg: "done read", data: { error: false } },
    ])
  );
  const edit = report.tools.find((t) => t.tool === "edit");
  assert.deepEqual(edit, { tool: "edit", calls: 3, failures: 2 });
  assert.equal(report.totalCalls, 4);
  assert.equal(report.totalFailures, 2);
});

test("tools come back busiest first", { skip: needsBuild }, () => {
  // The panel reads top-down and the question is always "what is the agent
  // spending its steps on", so the order has to be calls, not names.
  const readHealth = load();
  const events = [];
  for (let i = 0; i < 5; i++) events.push({ msg: "done read", data: { error: false } });
  for (let i = 0; i < 9; i++) events.push({ msg: "done bash", data: { error: false } });
  const report = readHealth(14, logs(events));
  assert.deepEqual(
    report.tools.map((t) => t.tool),
    ["bash", "read"]
  );
});

test("the events worth noticing are counted by name", { skip: needsBuild }, () => {
  const readHealth = load();
  const report = readHealth(
    14,
    logs([
      { msg: "turn failed" },
      { msg: "send failed, retrying" },
      { msg: "send failed, retrying" },
      { msg: "cooldown started" },
      { msg: "chatgpt is throttling this account" },
      { msg: "compacted" },
      { msg: "compaction did not shrink the transcript" },
      { msg: "payload truncated" },
      { msg: "step budget extended" },
    ])
  );
  assert.equal(report.turnFailures, 1);
  assert.equal(report.retries, 2);
  // Two different messages mean the same thing to the person reading the
  // panel: the account was put on a timer.
  assert.equal(report.cooldowns, 2);
  assert.equal(report.compactions, 1);
  assert.equal(report.compactionsThatFailed, 1);
  assert.equal(report.truncations, 1);
  assert.equal(report.budgetExtensions, 1);
});

test("failure reasons are grouped per tool and ranked", { skip: needsBuild }, () => {
  const readHealth = load();
  const report = readHealth(
    14,
    logs([
      { msg: "failed edit", data: { reason: "old_string not found" } },
      { msg: "failed edit", data: { reason: "old_string not found" } },
      { msg: "failed bash", data: { reason: "command not found" } },
      { msg: "failed edit", data: { reason: "file is not text" } },
    ])
  );
  assert.equal(report.reasons[0].count, 2);
  assert.equal(report.reasons[0].tool, "edit");
  assert.equal(report.reasons.length, 3);
});

test("the same reason from two tools stays two entries", { skip: needsBuild }, () => {
  // Grouped on the pair, not on the sentence: "file not found" from `read`
  // and from `bash` are different problems with the same words.
  const readHealth = load();
  const report = readHealth(
    14,
    logs([
      { msg: "failed read", data: { reason: "file not found" } },
      { msg: "failed bash", data: { reason: "file not found" } },
    ])
  );
  assert.equal(report.reasons.length, 2);
});

test("events older than the window are not counted", { skip: needsBuild }, () => {
  // A panel that says "last 14 days" and quietly means "all of history" is
  // the kind of wrong that gets believed.
  const readHealth = load();
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const report = readHealth(
    14,
    logs([
      { msg: "done edit", at: old, data: { error: true } },
      { msg: "done edit", data: { error: false } },
    ])
  );
  assert.equal(report.totalCalls, 1);
  assert.equal(report.totalFailures, 0);
});

test("a half-written last line does not lose the lines before it", { skip: needsBuild }, () => {
  // Normal while a session is running: the file is being appended to as it
  // is read.
  const readHealth = load();
  const dir = logs([{ msg: "done read", data: { error: false } }]);
  const file = path.join(dir, "20260914120000-aaaaaaaa.jsonl");
  fs.appendFileSync(file, '{"at":"2026-09-14T12:00:00.000Z","msg":"done re');
  const report = readHealth(14, dir);
  assert.equal(report.totalCalls, 1);
});

test("no logs at all is an empty report, not a failure", { skip: needsBuild }, () => {
  const readHealth = load();
  const report = readHealth(14, path.join(os.tmpdir(), "onflip-health-nothing-here"));
  assert.equal(report.totalCalls, 0);
  assert.equal(report.sessions, 0);
  assert.deepEqual(report.tools, []);
});

test("outbound messages and their size are counted", { skip: needsBuild }, () => {
  // The number the request-economy work is measured against: one `sending`
  // event is one request against the account, and its chars are what the
  // composer ceiling is measured against.
  const readHealth = load();
  const report = readHealth(
    14,
    logs([
      { msg: "sending", scope: "browser", data: { chars: 2000 } },
      { msg: "sending", scope: "browser", data: { chars: 4000 } },
      { msg: "sending", scope: "browser", data: {} },
      { msg: "done read", data: { error: false } },
    ])
  );
  assert.equal(report.sends, 2, "an event with no size is not a send we can measure");
  assert.equal(report.charsSent, 6000);
});

test("a control that moved on the service's page is counted", { skip: needsBuild }, () => {
  // The silent class of failure: the service redesigns its page, a click
  // finds nothing, nothing happens. DeepSeek unified its three modes and
  // OnFlip offered all three for a day, each doing nothing. Whatever else
  // changes, this number moving is the signal to go and look.
  const readHealth = load();
  const report = readHealth(
    14,
    logs([
      { msg: "the service's page has changed", level: "warn" },
      { msg: "the deep-thinking toggle was not on the page", level: "warn" },
      { msg: "could not read the account's model list", level: "warn" },
      { msg: "done read", data: { error: false } },
    ])
  );
  assert.equal(report.pageControlsMissing, 3);
});
