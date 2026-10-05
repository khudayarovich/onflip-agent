"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-audit-fixes-"));
const ROOT = path.resolve(__dirname, "..");
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, "config");
process.env.ONFLIP_PROVIDER = "chatgpt";
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { runTurn } = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");
const backoff = require("../dist/chatgpt/backoff");

async function scriptedTurn(replies) {
  const dir = fs.mkdtempSync(path.join(HOME, "turn-"));
  const signal = new AbortController().signal;
  const session = createSessionState();
  const history = [{ id: "s", role: "system", content: "prompt" }, { id: "u", role: "user", content: "write a file" }];
  const tools = createToolRegistry({ cwd: dir, session, signal, requestPermission: async () => ({ allow: true }) });
  let sends = 0;
  const pending = runTurn(history, {
    transport: { name: "api", reset() {}, async send() { sends++; return { conversationId: null, ...replies.shift() }; } },
    tools, session, signal, cwd: dir, model: "m", maxIterations: 12, shellEnabled: false, checkBeforeDone: false,
  });
  return { dir, pending, sends: () => sends };
}

const write = "```onflip\ntool: write\npath: result.js\ncontent: |\n  const unfinished = (\n```";
const done = "```onflip\ntool: done\nsummary: Complete.\n```";

test("exhausted truncation retries never execute a partial write or accept done", async () => {
  for (const content of [write, done]) {
    const turn = await scriptedTurn(Array.from({ length: 3 }, () => ({ content, meta: { truncated: true } })));
    await assert.rejects(turn.pending, /remained truncated/);
    assert.equal(turn.sends(), 3);
    assert.equal(fs.existsSync(path.join(turn.dir, "result.js")), false);
  }
});

test("a complete replacement after a truncated reply is still executable", async () => {
  const complete = write.replace("const unfinished = (", "const complete = true;");
  const turn = await scriptedTurn([{ content: write, meta: { truncated: true } }, { content: complete }, { content: done }]);
  await turn.pending;
  assert.match(fs.readFileSync(path.join(turn.dir, "result.js"), "utf8"), /const complete = true/);
});

test("a truncated reply is rejected when other corrections spent the whole nudge budget", async () => {
  const malformed = { content: "<onflip:tool>{broken</onflip:tool>" };
  const read = { content: "```onflip\ntool: read\npath: missing.txt\n```" };
  // A real call resets consecutive protocol corrections, but cannot reset
  // the budget for the entire turn.
  const turn = await scriptedTurn([malformed, malformed, read, malformed, malformed, read, malformed, malformed,
    { content: write, meta: { truncated: true } }]);
  await assert.rejects(turn.pending, /remained truncated/);
  assert.equal(turn.sends(), 9);
  assert.equal(fs.existsSync(path.join(turn.dir, "result.js")), false);
});

function worker(code, configDir, ...args) {
  const child = spawn(process.execPath, ["-e", code, ROOT, ...args], {
    env: { ...process.env, ONFLIP_CONFIG_DIR: configDir, ONFLIP_PROVIDER: "chatgpt" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "", errors = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { errors += data; });
  const ready = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (status) => { if (status !== 0) reject(new Error(errors)); });
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => status === 0 ? resolve(output) : reject(new Error(errors || `worker exited ${status}`)));
  });
  return { child, ready, finished };
}

test("concurrent config transactions preserve patches, removals and the longest cooldown", async () => {
  const dir = path.join(HOME, "concurrent");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ model: "old", count: 0 }));
  const code = `
    const path = require('node:path');
    const config = require(path.join(process.argv[1], 'dist/config'));
    const backoff = require(path.join(process.argv[1], 'dist/chatgpt/backoff'));
    const id = Number(process.argv[2]);
    process.send('ready');
    process.once('message', () => {
      for (let i = 0; i < 12; i++) {
        config.updateConfig(current => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          return { count: (current.count || 0) + 1 };
        });
        config.saveConfig({ ['worker' + id]: i });
        backoff.startCooldown(id === 0 ? 14400 : 60, 'test');
        if (id === 1) config.clearConfigKeys(['model']);
      }
      process.disconnect();
    });`;
  const workers = Array.from({ length: 4 }, (_, id) => worker(code, dir, String(id)));
  await Promise.all(workers.map((w) => w.ready));
  for (const w of workers) w.child.send("go");
  await Promise.all(workers.map((w) => w.finished));
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(stored.count, 48);
  for (let id = 0; id < 4; id++) assert.equal(stored[`worker${id}`], 11);
  assert.equal(stored.model, undefined);
  assert.ok(stored.cooldownUntil > Date.now() + 14390 * 1000);
});

test("a dead engine's config lock is recoverable by concurrent writers", async () => {
  const dir = path.join(HOME, "dead-owner");
  const exited = worker("process.send('ready'); process.once('message', () => process.disconnect());", dir);
  await exited.ready; exited.child.send("go"); await exited.finished;
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "config.json.lock"), JSON.stringify({ pid: exited.child.pid, token: "dead-owner" }));
  const code = `
    const path = require('node:path');
    const config = require(path.join(process.argv[1], 'dist/config'));
    process.send('ready');
    process.once('message', () => { config.saveConfig({ ['writer' + process.argv[2]]: true }); process.disconnect(); });`;
  const workers = [worker(code, dir, "1"), worker(code, dir, "2")];
  await Promise.all(workers.map(w => w.ready));
  for (const w of workers) w.child.send("go");
  await Promise.all(workers.map(w => w.finished));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "config.json"))), { writer1: true, writer2: true });
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("Windows lock deletion contention retries opening and reading without losing a transaction", {
  skip: process.platform !== "win32",
}, async () => {
  const exited = worker("process.send('ready'); process.once('message', () => process.disconnect());", HOME);
  await exited.ready; exited.child.send("go"); await exited.finished;
  const file = path.join(HOME, "windows-contention.json");
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: exited.child.pid, token: "dead" }));
  const original = fs.openSync, readOriginal = fs.readFileSync;
  const refused = new Set();
  fs.openSync = function(filePath, ...args) {
    if ([`${file}.lock`, `${file}.lock.recovery`].includes(filePath) && !refused.has(filePath)) {
      refused.add(filePath);
      throw Object.assign(new Error("lock file is being deleted"), { code: "EPERM" });
    }
    return original.call(this, filePath, ...args);
  };
  fs.readFileSync = function(filePath, ...args) {
    if (filePath === `${file}.lock` && !refused.has("read")) {
      refused.add("read");
      throw Object.assign(new Error("lock read is being deleted"), { code: "EPERM" });
    }
    return readOriginal.call(this, filePath, ...args);
  };
  try {
    require("../dist/file-lock").withFileLockSync(file, () => fs.writeFileSync(file, "saved"));
    assert.equal(refused.size, 3);
    assert.equal(fs.readFileSync(file, "utf8"), "saved");
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally { fs.openSync = original; fs.readFileSync = readOriginal; }
});

const paceCode = `
  const path = require('node:path');
  const backoff = require(path.join(process.argv[1], 'dist/chatgpt/backoff'));
  process.send('ready');
  process.once('message', async () => {
    await backoff[process.argv[2]]();
    process.stdout.write(JSON.stringify({ at: Date.now(), chats: backoff.newChatsInWindow() }));
    process.disconnect();
  });`;

test("a read-only Windows folder preserves its access error for the local pacing fallback", {
  skip: process.platform !== "win32",
}, () => {
  const file = path.join(HOME, "read-only-lock.json");
  const original = fs.openSync, accessOriginal = fs.accessSync;
  fs.openSync = function(filePath, ...args) {
    if (filePath === `${file}.lock`) throw Object.assign(new Error("access denied"), { code: "EACCES" });
    return original.call(this, filePath, ...args);
  };
  fs.accessSync = function(dir, ...args) {
    if (dir === HOME) throw Object.assign(new Error("folder is read-only"), { code: "EACCES" });
    return accessOriginal.call(this, dir, ...args);
  };
  try {
    let ran = false;
    assert.throws(() => require("../dist/file-lock").withFileLockSync(file, () => { ran = true; }),
      (e) => e.code === "EACCES");
    assert.equal(ran, false);
  } finally { fs.openSync = original; fs.accessSync = accessOriginal; }
});

test("two engine processes cannot claim the same send slot", async () => {
  const dir = path.join(HOME, "shared-send");
  const workers = [worker(paceCode, dir, "paceSend"), worker(paceCode, dir, "paceSend")];
  await Promise.all(workers.map((w) => w.ready));
  for (const w of workers) w.child.send("go");
  const times = (await Promise.all(workers.map((w) => w.finished))).map((v) => JSON.parse(v).at).sort((a, b) => a - b);
  assert.ok(times[1] - times[0] >= 1400, `sends only ${times[1] - times[0]}ms apart`);
});

test("a restarted engine inherits new-chat pacing history", async () => {
  const dir = path.join(HOME, "shared-chat");
  const first = worker(paceCode, dir, "paceNewChat");
  await first.ready; first.child.send("go");
  const one = JSON.parse(await first.finished);
  const second = worker(paceCode, dir, "paceNewChat");
  await second.ready; second.child.send("go");
  const two = JSON.parse(await second.finished);
  assert.equal(one.chats, 1);
  assert.equal(two.chats, 2);
  assert.ok(two.at - one.at >= 2900);
});

test("a cooldown beginning during pacing blocks the pending send", async () => {
  backoff.__resetPacingForTest();
  await backoff.paceSend();
  const before = fs.readFileSync(path.join(process.env.ONFLIP_CONFIG_DIR, "pacing.json"), "utf8");
  const pending = backoff.paceSend();
  const timer = setTimeout(() => backoff.startCooldown(60, "test"), 20);
  try {
    await assert.rejects(pending, /cooldown/);
    assert.equal(fs.readFileSync(path.join(process.env.ONFLIP_CONFIG_DIR, "pacing.json"), "utf8"), before);
  } finally { clearTimeout(timer); backoff.clearCooldown(); backoff.__resetPacingForTest(); }
});

test("an asynchronous log open failure does not crash and a later log can open", async () => {
  const dir = path.join(HOME, "logging");
  const code = `
    const fs = require('node:fs'), path = require('node:path');
    const log = require(path.join(process.argv[1], 'dist/log'));
    fs.mkdirSync(path.join(process.env.ONFLIP_CONFIG_DIR, 'logs', 'bad.jsonl'), { recursive: true });
    process.send('ready');
    process.once('message', async () => {
      log.openLog('bad'); log.logger.info('test', 'first');
      await new Promise(resolve => setTimeout(resolve, 50));
      if (log.logFile() !== null) throw new Error('failed log remained open');
      log.openLog('good'); log.logger.info('test', 'recovered'); log.closeLog();
      await new Promise(resolve => setTimeout(resolve, 50));
      process.stdout.write(fs.readFileSync(path.join(process.env.ONFLIP_CONFIG_DIR, 'logs', 'good.jsonl'), 'utf8'));
      process.disconnect();
    });`;
  const child = worker(code, dir);
  await child.ready; child.child.send("go");
  assert.match(await child.finished, /recovered/);
});

const net = require("../dist/tools/net-guard");
const { downloadFileTool } = require("../dist/tools/web");
const originalFetch = net.fetchPublic;
test.afterEach(() => { net.fetchPublic = originalFetch; });

function download(dir, permission = async () => ({ allow: true }), signal = new AbortController().signal) {
  return downloadFileTool.run({ url: "https://example.com/asset", path: "asset.bin" }, { cwd: dir, signal, requestPermission: permission });
}

test("a download cannot overwrite changes made during approval or fetching", async () => {
  for (const stage of ["approval", "fetch"]) {
    const dir = fs.mkdtempSync(path.join(HOME, "download-"));
    const file = path.join(dir, "asset.bin");
    fs.writeFileSync(file, "before");
    net.fetchPublic = async () => {
      if (stage === "fetch") fs.writeFileSync(file, "user changes");
      return new Response("download");
    };
    const result = await download(dir, async (request) => {
      if (stage === "approval" && request.kind === "write") fs.writeFileSync(file, "user changes");
      return { allow: true };
    });
    assert.equal(result.error, true);
    assert.match(result.output, /destination changed/);
    assert.equal(fs.readFileSync(file, "utf8"), "user changes");
  }
});

test("a parent swapped for a junction after approval cannot redirect a download", async () => {
  const root = fs.mkdtempSync(path.join(HOME, "junction-"));
  const dir = path.join(root, "approved"), outside = path.join(root, "outside");
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  net.fetchPublic = async () => {
    fs.renameSync(dir, path.join(root, "original"));
    fs.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
    return new Response("download");
  };
  const result = await download(dir);
  assert.equal(result.error, true);
  assert.equal(fs.existsSync(path.join(outside, "asset.bin")), false);
});

test("a directory swap during preparation is not adopted as the approved destination", async () => {
  const root = fs.mkdtempSync(path.join(HOME, "prepare-junction-"));
  const dir = path.join(root, "approved"), outside = path.join(root, "outside");
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  net.fetchPublic = async () => new Response("download");
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (candidate, options) => {
    if (candidate === dir) {
      fs.renameSync(dir, path.join(root, "original"));
      fs.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
    }
    return mkdir(candidate, options);
  };
  let result;
  try { result = await download(dir); }
  finally { fs.mkdirSync = mkdir; }
  assert.equal(result.error, true);
  assert.equal(fs.existsSync(path.join(outside, "asset.bin")), false);
});

test("a download may create a missing ordinary directory", async () => {
  const root = fs.mkdtempSync(path.join(HOME, "nested-download-"));
  const dir = path.join(root, "one", "two");
  net.fetchPublic = async () => new Response("download");
  const result = await download(dir);
  assert.equal(result.error, undefined, result.output);
  assert.equal(fs.readFileSync(path.join(dir, "asset.bin"), "utf8"), "download");
});

test("binary downloads replace the destination intact and failed replacement preserves it", async () => {
  const dir = fs.mkdtempSync(path.join(HOME, "binary-"));
  const file = path.join(dir, "asset.bin");
  const bytes = Buffer.from([0, 255, 254, 42]);
  net.fetchPublic = async () => new Response(bytes);
  assert.equal((await download(dir)).error, undefined);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("replacement failed"); };
  try {
    net.fetchPublic = async () => new Response("new download");
    assert.equal((await download(dir)).error, true);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(dir), ["asset.bin"]);
});

test("a download cancelled while awaiting approval never reaches the network", async () => {
  const dir = fs.mkdtempSync(path.join(HOME, "cancel-"));
  const controller = new AbortController();
  net.fetchPublic = async () => { throw new Error("must not fetch"); };
  const result = await download(dir, async () => { controller.abort(); return { allow: true }; }, controller.signal);
  assert.match(result.output, /interrupted/);
  assert.equal(fs.existsSync(path.join(dir, "asset.bin")), false);
});
