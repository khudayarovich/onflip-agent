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

// Timestamps are the identity Undo checks, so each step waits long enough
// for a rewrite to carry a new one — or a missing fix would pass by luck.
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);

/** What Engine.undoLast does once it has decided to go ahead. */
function undo(snapshots) {
  const { adoptRestoredRevision, restoreSnapshot, snapshotStillCurrent } = require(UNDO);
  const last = snapshots[snapshots.length - 1];
  if (!snapshotStillCurrent(last)) return false;
  restoreSnapshot(last);
  snapshots.pop();
  adoptRestoredRevision(snapshots, last);
  tick();
  return true;
}

test("a second Undo of the same file goes back another step", { skip: needsBuild }, () => {
  // The first Undo rewrites the file, so its identity no longer matched the
  // earlier snapshot's, and the second refused: "it changed after OnFlip's
  // edit" - about OnFlip's own undo.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-undo-"));
  try {
    const file = path.join(dir, "app.ts");
    fs.writeFileSync(file, "v0", "utf8");
    const snapshots = [snapshot(file, "v0", "v1")];
    tick();
    snapshots.push(snapshot(file, "v1", "v2"));
    tick();
    assert.equal(undo(snapshots), true);
    assert.equal(fs.readFileSync(file, "utf8"), "v1");
    assert.equal(undo(snapshots), true, "the second Undo was refused");
    assert.equal(fs.readFileSync(file, "utf8"), "v0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file OnFlip created and then edited can be undone all the way", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-undo-"));
  try {
    const file = path.join(dir, "new.ts");
    const snapshots = [snapshot(file, null, "draft")];
    tick();
    snapshots.push(snapshot(file, "draft", "final"));
    tick();
    assert.equal(undo(snapshots), true);
    assert.equal(undo(snapshots), true, "the create could never be undone");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("but an edit made after the first Undo still stops the second", { skip: needsBuild }, () => {
  // The false-positive half: re-adopting the file's identity is for the
  // write the undo itself made, not for anything that came after it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-undo-"));
  try {
    const file = path.join(dir, "app.ts");
    fs.writeFileSync(file, "v0", "utf8");
    const snapshots = [snapshot(file, "v0", "v1")];
    tick();
    snapshots.push(snapshot(file, "v1", "v2"));
    tick();
    assert.equal(undo(snapshots), true);
    fs.writeFileSync(file, "v1 and the user's line", "utf8");
    assert.equal(undo(snapshots), false);
    assert.equal(fs.readFileSync(file, "utf8"), "v1 and the user's line");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
