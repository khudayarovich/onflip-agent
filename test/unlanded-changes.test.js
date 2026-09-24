"use strict";

/**
 * A `done` that claims a change which never landed.
 *
 * Measured on a Free account: "make the dark squares of the board blue" —
 * the edit failed with `old_string` not found, the model read the file, ran
 * the build and sent `done` with "Updated the chessboard dark squares to
 * blue". Nothing had changed. The ledger is what notices, without reading a
 * word the model wrote: a failed change counts as landed only once a later
 * call to the same file succeeds or the file's modification time moves.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { recordChange, unlanded } = require("../dist/agent/landed");
const { unlandedChangeNudge } = require("../dist/agent/system");

const CWD = path.resolve("/work/chess");
const FAILED = { error: true, output: "`old_string` not found in src/styles.css. Read the file again." };
const OK = { output: "Edited src/styles.css" };

// A fake clock for modification times, so nothing touches the disk.
function disk(times) {
  return (file) => (Object.hasOwn(times, file) ? times[file] : -1);
}

test("a failed edit that nothing redoes is outstanding at done", () => {
  const ledger = new Map();
  const file = path.join(CWD, "src/styles.css");
  const stat = disk({ [file]: 1000 });
  recordChange(ledger, "edit", { path: "src/styles.css" }, FAILED, CWD, stat);
  const left = unlanded(ledger, stat);
  assert.equal(left.length, 1);
  assert.equal(left[0].path, "src/styles.css");
  assert.match(left[0].reason, /old_string` not found/);
});

test("a later successful change to the same file clears it", () => {
  const ledger = new Map();
  const file = path.join(CWD, "src/styles.css");
  const stat = disk({ [file]: 1000 });
  recordChange(ledger, "edit", { path: "src/styles.css" }, FAILED, CWD, stat);
  // Spelled differently, same file.
  recordChange(ledger, "write", { path: "./src/../src/styles.css" }, OK, CWD, stat);
  assert.deepEqual(unlanded(ledger, stat), []);
});

test("a file changed some other way since the failure is believed", () => {
  // A shell command fixed it: the tool never reported success, the disk did.
  const ledger = new Map();
  const file = path.join(CWD, "src/styles.css");
  recordChange(ledger, "edit", { path: "src/styles.css" }, FAILED, CWD, disk({ [file]: 1000 }));
  assert.deepEqual(unlanded(ledger, disk({ [file]: 2000 })), []);
});

test("a change the user declined is not held against the model", () => {
  const ledger = new Map();
  const file = path.join(CWD, "src/styles.css");
  const stat = disk({ [file]: 1000 });
  recordChange(ledger, "edit", { path: "src/styles.css" }, FAILED, CWD, stat);
  recordChange(ledger, "edit", { path: "src/styles.css" }, { error: true, denied: true, output: "declined" }, CWD, stat);
  assert.deepEqual(unlanded(ledger, stat), []);
});

test("reads, commands and failures without a path leave the ledger alone", () => {
  const ledger = new Map();
  const stat = disk({});
  recordChange(ledger, "read", { path: "src/styles.css" }, FAILED, CWD, stat);
  recordChange(ledger, "bash", { command: "npm run build" }, FAILED, CWD, stat);
  recordChange(ledger, "edit", {}, FAILED, CWD, stat);
  assert.equal(ledger.size, 0);
});

test("a failed write to a file that never existed stays outstanding", () => {
  const ledger = new Map();
  const stat = disk({});
  recordChange(ledger, "write", { path: "src/board.css" }, { error: true, output: "EACCES" }, CWD, stat);
  assert.equal(unlanded(ledger, stat).length, 1);
});

test("the reminder names each file and says why", () => {
  const text = unlandedChangeNudge({
    changes: [{ path: "src/styles.css", reason: "`old_string` not found in src/styles.css." }],
  });
  assert.match(text, /src\/styles\.css: `old_string` not found/);
  assert.match(text, /does not contain what your summary describes/);
});
