"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const DIST = path.join(__dirname, "..", "dist", "engine", "usage.js");
const needsBuild = fs.existsSync(DIST) ? false : "desktop/dist is not built";

test("usage increments from concurrent engine processes are never lost", { skip: needsBuild }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-usage-"));
  const env = { ...process.env, ONFLIP_CONFIG_DIR: dir };
  const childCode = `
    const usage = require(${JSON.stringify(DIST)});
    for (let i = 0; i < 50; i++) usage.recordSend("review@example.test");
    usage.closeUsageStore();
  `;
  try {
    const jobs = Array.from({ length: 20 }, () => new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, ["-e", childCode], { env, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
    }));
    await Promise.all(jobs);

    const db = new Database(path.join(dir, "usage.sqlite3"), { readonly: true });
    try {
      const row = db.prepare("SELECT total FROM usage_accounts WHERE account = ?")
        .get("review@example.test");
      assert.equal(row.total, 1000);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the old usage.json is migrated once", { skip: needsBuild }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-usage-"));
  const today = new Date();
  const key = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({
    "legacy@example.test": { total: 7, since: 1234, days: { [key]: 7 } },
  }));
  const code = `
    const usage = require(${JSON.stringify(DIST)});
    console.log(JSON.stringify(usage.usageSummary("legacy@example.test")));
    usage.closeUsageStore();
  `;
  try {
    const first = cp.spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { ...process.env, ONFLIP_CONFIG_DIR: dir },
    });
    const second = cp.spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { ...process.env, ONFLIP_CONFIG_DIR: dir },
    });
    assert.equal(JSON.parse(first.stdout.trim()).total, 7);
    assert.equal(JSON.parse(second.stdout.trim()).total, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
