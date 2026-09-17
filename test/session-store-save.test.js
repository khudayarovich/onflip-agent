"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "agent", "store.js");
const needsBuild = fs.existsSync(DIST) ? false : "dist is not built";

test("saveSession reports failure so callers can retry", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-session-save-"));
  const code = `
    const fs = require("node:fs");
    const path = require("node:path");
    const store = require(${JSON.stringify(DIST)});
    const sessions = store.sessionsDirectory();
    fs.mkdirSync(path.dirname(sessions), { recursive: true });
    fs.writeFileSync(sessions, "blocks mkdir");
    const session = {
      id: "save-result",
      title: "test",
      cwd: process.cwd(),
      model: "test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      todos: [],
      snapshots: []
    };
    const failed = store.saveSession(session);
    fs.rmSync(sessions, { force: true });
    const succeeded = store.saveSession(session);
    console.log(JSON.stringify({ failed, succeeded }));
  `;
  try {
    const result = cp.spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { ...process.env, ONFLIP_CONFIG_DIR: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { failed: false, succeeded: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
