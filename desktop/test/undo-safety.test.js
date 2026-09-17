"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UNDO = path.join(__dirname, "..", "dist", "engine", "undo.js");
const REVISION = path.join(__dirname, "..", "..", "dist", "tools", "revision.js");
const needsBuild = fs.existsSync(UNDO) && fs.existsSync(REVISION)
  ? false
  : "desktop and core dist are not built";

function snapshot(file, before, after) {
  fs.writeFileSync(file, after, "utf8");
  const { contents: _contents, ...afterRevision } = require(REVISION).captureFileRevision(file);
  return { path: file, before, after, afterRevision, tool: "edit", at: Date.now() };
}

test("Undo accepts the exact file the agent left and restores it", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-undo-"));
  try {
    const file = path.join(dir, "example.txt");
    const item = snapshot(file, "before", "after");
    const { snapshotStillCurrent, restoreSnapshot } = require(UNDO);
    assert.equal(snapshotStillCurrent(item), true);
    restoreSnapshot(item);
    assert.equal(fs.readFileSync(file, "utf8"), "before");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Undo refuses a file edited after the agent's change", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-undo-"));
  try {
    const file = path.join(dir, "example.txt");
    const item = snapshot(file, "before", "after");
    fs.writeFileSync(file, "the user's newer edit", "utf8");
    const { snapshotStillCurrent } = require(UNDO);
    assert.equal(snapshotStillCurrent(item), false);
    assert.equal(fs.readFileSync(file, "utf8"), "the user's newer edit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy snapshots still compare their saved contents", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-undo-"));
  try {
    const file = path.join(dir, "example.txt");
    fs.writeFileSync(file, "after", "utf8");
    const legacy = { path: file, before: "before", after: "after", tool: "edit", at: Date.now() };
    const { snapshotStillCurrent } = require(UNDO);
    assert.equal(snapshotStillCurrent(legacy), true);
    fs.writeFileSync(file, "newer", "utf8");
    assert.equal(snapshotStillCurrent(legacy), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
