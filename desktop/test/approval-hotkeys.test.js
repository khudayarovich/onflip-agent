"use strict";

/**
 * The approval prompt's letter keys answer it only when they were meant to.
 *
 * `a` is "always allow", and Chromium reports Ctrl+A with `key` "a" — so
 * selecting the command to copy it approved it permanently, into the
 * allowlist. Ctrl+Y allowed it once; a held `y` ran on into the next prompt;
 * a candidate key from an input method, a dropdown, or the embedded browser
 * (which forwards keys to the agent's page) could each answer it; and a
 * prompt that appeared mid-sentence took the next letter typed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "approval.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const plainTarget = { tagName: "DIV", isContentEditable: false, closest: () => null };
const key = (k, extra = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  target: plainTarget,
  ...extra,
});

test("a plain letter on the page answers the prompt", { skip: needsBuild }, () => {
  const { isApprovalHotkey } = require(DIST);
  for (const k of ["y", "a", "n", "Y"]) assert.equal(isApprovalHotkey(key(k), true), true, k);
});

test("a chord is never an answer", { skip: needsBuild }, () => {
  const { isApprovalHotkey } = require(DIST);
  assert.equal(isApprovalHotkey(key("a", { ctrlKey: true }), true), false, "Ctrl+A selects text");
  assert.equal(isApprovalHotkey(key("a", { metaKey: true }), true), false, "Cmd+A selects text");
  assert.equal(isApprovalHotkey(key("y", { ctrlKey: true }), true), false);
  assert.equal(isApprovalHotkey(key("y", { altKey: true }), true), false);
});

test("a held key, an input method and a fresh prompt do not answer it", { skip: needsBuild }, () => {
  const { isApprovalHotkey } = require(DIST);
  assert.equal(isApprovalHotkey(key("y", { repeat: true }), true), false);
  assert.equal(isApprovalHotkey(key("a", { isComposing: true }), true), false);
  assert.equal(isApprovalHotkey(key("y"), false), false, "not armed yet");
});

test("typing somewhere else is typing, not an answer", { skip: needsBuild }, () => {
  const { isApprovalHotkey } = require(DIST);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(isApprovalHotkey(key("y", { target: { ...plainTarget, tagName } }), true), false, tagName);
  }
  assert.equal(isApprovalHotkey(key("y", { target: { ...plainTarget, isContentEditable: true } }), true), false);
  const inBrowser = { ...plainTarget, closest: (s) => (s === ".browser-panel" ? {} : null) };
  assert.equal(isApprovalHotkey(key("y", { target: inBrowser }), true), false, "the embedded browser");
});

test("Escape always denies, armed or not", { skip: needsBuild }, () => {
  const { isApprovalHotkey } = require(DIST);
  assert.equal(isApprovalHotkey(key("Escape"), false), true);
  assert.equal(isApprovalHotkey(key("Escape", { target: { ...plainTarget, tagName: "INPUT" } }), true), true);
});

test("and the prompt goes through this rule rather than reading keys itself", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "components", "ApprovalModal.tsx"), "utf8");
  assert.match(source, /isApprovalHotkey\(/);
  assert.doesNotMatch(source, /tagName === "INPUT" \|\| target\.tagName === "TEXTAREA"/, "the old check is gone");
});
