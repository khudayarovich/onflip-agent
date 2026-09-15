"use strict";

/**
 * Which access modes a machine will honour, and which it will not offer.
 *
 * `full-auto` and `yolo` hand the model's output straight to the shell. An
 * external audit of the shipped build showed what that means in practice: a
 * command allowlist cannot see through an interpreter, a package manager, or
 * a script the model has just written, so "everything except the destructive
 * ones" is a promise the regular expressions cannot keep.
 *
 * The owner's decision was to take those two off the Mac — the machine that
 * runs unattended, driven from a phone, where nobody is looking at the screen
 * when a command runs. These tests pin the rule and, just as importantly, pin
 * that it stops there: no other platform loses anything, and the escape hatch
 * works.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPROVAL_MODES,
  availableModes,
  clampApprovalMode,
  unattendedAllowed,
} = require("../dist/agent/permissions");

test("a Mac is not offered the unattended modes", () => {
  assert.equal(unattendedAllowed("darwin", undefined), false);
  assert.deepEqual(availableModes("darwin", undefined), ["read-only", "ask", "auto-edit"]);
});

test("and every other platform keeps all of them", () => {
  // The honest caveat, asserted rather than left in a comment: the risk is
  // not macOS-specific, and this rule does not pretend otherwise. It is a
  // decision about one machine, not a claim about one operating system.
  for (const platform of ["win32", "linux", "freebsd"]) {
    assert.equal(unattendedAllowed(platform, undefined), true, platform);
    assert.deepEqual(availableModes(platform, undefined), [...APPROVAL_MODES], platform);
  }
});

test("ONFLIP_ALLOW_FULL_ACCESS=1 puts them back", () => {
  // A guard with no way past it is a guard people route around by worse
  // means. Setting an environment variable is a deliberate act; clicking a
  // menu entry is not.
  assert.equal(unattendedAllowed("darwin", "1"), true);
  assert.deepEqual(availableModes("darwin", "1"), [...APPROVAL_MODES]);
});

test("and nothing else in the variable counts as yes", () => {
  // "0", "false" and "true" are all things a person types meaning different
  // things. Only the documented value opens the door.
  for (const value of ["0", "", "false", "true", "yes", "ONFLIP_ALLOW_FULL_ACCESS"]) {
    assert.equal(unattendedAllowed("darwin", value), false, JSON.stringify(value));
  }
});

test("a stored full-access mode is clamped, not obeyed", () => {
  // The config travels: it is written by whichever machine was last in it,
  // and a build older than this rule wrote whatever was chosen. Clamping on
  // read is what stops a Mac coming back up in a mode nobody chose on it.
  assert.equal(clampApprovalMode("full-auto", "darwin", undefined), "ask");
  assert.equal(clampApprovalMode("yolo", "darwin", undefined), "ask");
});

test("the modes that remain are left exactly as they are", () => {
  for (const mode of ["read-only", "ask", "auto-edit"]) {
    assert.equal(clampApprovalMode(mode, "darwin", undefined), mode);
    assert.equal(clampApprovalMode(mode, "win32", undefined), mode);
  }
  assert.equal(clampApprovalMode("full-auto", "win32", undefined), "full-auto");
  assert.equal(clampApprovalMode("yolo", "linux", undefined), "yolo");
  assert.equal(clampApprovalMode("full-auto", "darwin", "1"), "full-auto");
});

test("whatever it clamps to is itself on offer", () => {
  // The bug this catches is a later edit changing the fallback to something
  // the same rule removes - a clamp that lands outside the menu leaves the
  // chip naming a mode the picker will not show, and setting anything else
  // becomes the only way out of it.
  for (const platform of ["darwin", "win32", "linux"]) {
    const offered = availableModes(platform, undefined);
    for (const mode of APPROVAL_MODES) {
      assert.ok(
        offered.includes(clampApprovalMode(mode, platform, undefined)),
        `${platform}: ${mode} clamped outside the offered list`
      );
    }
  }
});
