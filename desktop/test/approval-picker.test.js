"use strict";

/**
 * A picker must not offer what the engine will refuse.
 *
 * `full-auto` and `yolo` are gone on macOS — the engine clamps them to `ask`
 * on the way in. A menu that still lists them does not become harmless by
 * being ignored: the person taps "Full-access", the engine stores "ask", and
 * nothing anywhere says so. They walk away believing they turned something
 * on. That is a worse outcome than the mode itself would have been, because
 * it is a belief about the machine that is simply false.
 *
 * Two pickers draw that menu — the chip in the window and the `/access`
 * keyboard on the phone — and they share this one filter so they cannot
 * disagree. That each of them still calls it is checked next door, in
 * approval-wiring.test.js and telegram-access.test.js — this file is only
 * about what the filter itself answers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "approval.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

test("a mode the engine does not list is not offered", { skip: needsBuild }, () => {
  const { isOffered } = require(DIST);

  const mac = ["read-only", "ask", "auto-edit"];
  assert.equal(isOffered("full-auto", mac), false);
  assert.equal(isOffered("yolo", mac), false);
  assert.equal(isOffered("ask", mac), true);
  assert.equal(isOffered("read-only", mac), true);
  assert.equal(isOffered("auto-edit", mac), true);
});

test("a machine that lists them still offers them", { skip: needsBuild }, () => {
  const { isOffered } = require(DIST);

  const all = ["read-only", "ask", "auto-edit", "full-auto", "yolo"];
  for (const mode of all) assert.equal(isOffered(mode, all), true, mode);
});

test("an engine that says nothing is not read as allowing nothing", { skip: needsBuild }, () => {
  // The app and the engine are separate processes and upgrade separately.
  // An engine older than this rule sends no list, honours every mode, and
  // must not end up behind an empty menu.
  const { isOffered } = require(DIST);

  for (const mode of ["read-only", "ask", "auto-edit", "full-auto", "yolo"]) {
    assert.equal(isOffered(mode, undefined), true, mode);
    assert.equal(isOffered(mode, []), true, mode);
  }
});
