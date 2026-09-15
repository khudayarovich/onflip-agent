"use strict";

/**
 * Both ends of the access-mode contract are still connected.
 *
 * On macOS the engine refuses `full-auto` and `yolo` and clamps them to
 * `ask`. Three pieces have to hold for that to be honest: the engine
 * publishes what it will accept, the engine clamps what it is given, and the
 * menus filter by the published list. Break any one and the person picks
 * "Full access", the engine stores "ask", and nothing says so — they walk
 * away holding a belief about their machine that is false.
 *
 * These are source-level checks on purpose. The renderer is bundled, so
 * there is nothing to require and no harness that can call into the
 * component; the engine is a class that needs half an app around it to
 * build. What these catch is the one-word edit — `offeredModes(status)`
 * slipping back to `APPROVAL_MODES`, a dropped line in `statusPayload` —
 * which typechecks, builds, passes every other test, and quietly restores
 * the lying menu on every Mac.
 *
 * Reading source is a weak test, and it is placed accordingly: the rule
 * itself is tested properly in approval-picker.test.js and, on the engine
 * side, in the root suite's approval-modes.test.js. This file only asserts
 * the call sites are still wired to them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const COMPOSER = path.join(__dirname, "..", "ui", "src", "components", "Composer.tsx");

test("the chip's menu is built from the filtered list", () => {
  const source = fs.readFileSync(COMPOSER, "utf8");

  // The menu entries come from the filtered list, not the constant.
  assert.match(source, /\.\.\.offeredModes\(status\)\.map\(/);
  // And the filter is the shared one, asked about the engine's own list.
  assert.match(source, /isOffered\(m\.mode, status\?\.approvalModes\)/);
});

test("and the label still names whatever mode is in effect", () => {
  // The other half, easy to break while fixing the first: `approvalInfo`
  // must keep looking at the *whole* list. A machine sitting in a mode that
  // is no longer offered should read "Full access" on the chip, not fall
  // back to naming some other mode it is not in.
  const source = fs.readFileSync(COMPOSER, "utf8");

  assert.match(source, /function approvalInfo[\s\S]{0,160}APPROVAL_MODES\.find/);
});

test("the engine publishes the list the pickers filter by", () => {
  // Without this field on the status, `isOffered` sees nothing, answers yes
  // to everything, and both menus go back to offering modes the engine
  // clamps away - which is the entire failure this change exists to stop.
  // It is one line in one method, and it is quiet when it goes missing.
  const engine = fs.readFileSync(path.join(__dirname, "..", "engine", "engine.ts"), "utf8");

  assert.match(engine, /statusPayload\(\)[\s\S]{0,3000}?approvalModes: availableModes\(\)/);
});

test("and clamps what it is asked for rather than trusting it", () => {
  // The stored value travels between machines and between builds, so both
  // doors are clamped: what is read at startup and what is set later. A
  // picker that no longer offers the mode is a courtesy; this is the part
  // that actually holds.
  const engine = fs.readFileSync(path.join(__dirname, "..", "engine", "engine.ts"), "utf8");

  assert.match(engine, /setApproval\(mode: ApprovalMode\)[\s\S]{0,600}?clampApprovalMode\(mode\)/);
  assert.match(engine, /this\.approvalMode = clampApprovalMode\(/);
});
