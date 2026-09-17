"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const DIST = path.join(__dirname, "..", "dist", "engine", "session-lock.js");
const needsBuild = fs.existsSync(DIST) ? false : "desktop/dist is not built";

function childCode(id, holdMs) {
  return `
    const lock = require(${JSON.stringify(DIST)});
    const ok = lock.claimSessionLock(${JSON.stringify(id)});
    console.log(JSON.stringify({ ok, file: lock.sessionLockFile(${JSON.stringify(id)}) }));
    setTimeout(() => {
      if (ok) lock.releaseSessionLock(${JSON.stringify(id)});
    }, ${holdMs});
  `;
}

test("provider session locks live beside that provider's sessions", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-locks-"));
  try {
    const result = cp.spawnSync(process.execPath, ["-e", childCode("provider", 0)], {
      encoding: "utf8",
      env: { ...process.env, ONFLIP_CONFIG_DIR: dir, ONFLIP_PROVIDER: "qwen" },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = JSON.parse(result.stdout.trim());
    assert.equal(line.ok, true);
    assert.equal(
      path.normalize(line.file),
      path.join(dir, "providers", "qwen", "sessions", "provider.lock")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only one process can acquire a live session lock", { skip: needsBuild }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-locks-"));
  const env = { ...process.env, ONFLIP_CONFIG_DIR: dir, ONFLIP_PROVIDER: "deepseek" };
  try {
    const first = cp.spawn(process.execPath, ["-e", childCode("shared", 500)], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(first, "exit");
    const [chunk] = await once(first.stdout, "data");
    assert.equal(JSON.parse(String(chunk).trim()).ok, true);

    const second = cp.spawnSync(process.execPath, ["-e", childCode("shared", 0)], {
      encoding: "utf8",
      env,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout.trim()).ok, false);
    await exited;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
