"use strict";

/**
 * The access picker on the phone offers what the machine will honour.
 *
 * The engine publishes the list it accepts on the status, and on a Mac that
 * list no longer has the unattended modes on it. The window filters by it;
 * so must the bot, and for a sharper reason — the person tapping the button
 * is not at the machine. A control that appears to grant full access and
 * quietly grants something narrower is a lie told to somebody who has no way
 * of seeing the result.
 *
 * The other half is that a *new* bot must keep working against an *old*
 * engine, which sends no list at all. Filtering an absent list down to
 * nothing would leave a picker with no buttons in it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "telegram.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/** The module reaches for Electron at the top; only pure exports are used. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-access";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-access"] = {
    id: "electron-stub-access",
    filename: "electron-stub-access",
    loaded: true,
    exports: {
      app: { getPath: () => "" },
      safeStorage: { isEncryptionAvailable: () => false },
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

test("a Mac's list drops Full-access from the picker", { skip: needsBuild }, () => {
  const { accessChoices } = load();

  const offered = accessChoices(["read-only", "ask", "auto-edit"]);
  assert.deepEqual(
    offered.map((o) => o.value),
    ["read-only", "ask", "auto-edit"]
  );
  assert.ok(!offered.some((o) => o.value === "full-auto"));
});

test("and a machine that allows it still sees it", { skip: needsBuild }, () => {
  const { accessChoices } = load();

  const offered = accessChoices(["read-only", "ask", "auto-edit", "full-auto", "yolo"]);
  assert.deepEqual(
    offered.map((o) => o.value),
    ["read-only", "ask", "auto-edit", "full-auto"]
  );
  // `yolo` is not in the bot's menu at all and never has been - a mode with
  // no confirmation of any kind is not something to hand to a tap on a
  // phone. The engine offering it does not put it there.
});

test("an engine too old to send a list is not filtered down to nothing", { skip: needsBuild }, () => {
  // The upgrade order is not ours to choose: the bot lives in the app and
  // the engine is a separate process that may be older. An empty picker
  // would be a broken remote, not a safe one.
  const { accessChoices } = load();

  assert.equal(accessChoices(undefined).length, 4);
  assert.equal(accessChoices([]).length, 4);
});

test("the labels stay the engine's own names underneath", { skip: needsBuild }, () => {
  // The bug this file's neighbour was written for: the button said
  // "Full-access", the engine accepts "full-auto", and setApproval with the
  // label silently did nothing. Filtering must not become a place where the
  // two drift apart again.
  const { accessChoices } = load();

  for (const choice of accessChoices(undefined)) {
    assert.match(choice.value, /^(read-only|ask|auto-edit|full-auto|yolo)$/);
    assert.ok(choice.label.length > 0);
  }
});
