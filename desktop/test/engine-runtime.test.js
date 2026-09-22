"use strict";

/**
 * The engine runs where the sqlite binding the app ships can be opened.
 *
 * The installer is built on Node 22 and ships a binding for that ABI plus
 * one for Electron's, and the engine was started with whatever `node` the
 * machine had. On Node 24 the usage store never opened: every count read
 * zero and a warning was logged every five seconds for the life of the app.
 * The machine's Node is now asked once whether it can do the load the
 * engine will do, and the engine runs under Electron-as-Node when it cannot.
 *
 * The probe is run for real, with this Node, against a stand-in
 * better-sqlite3 that fails the way a binding for another ABI does.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "electron", "engine-runtime.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const load = () => require(DIST);

/** An engine directory whose better-sqlite3 behaves as `body` says. */
function fixture(body, { prebuilt = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-runtime-"));
  const pkg = path.join(root, "engine", "node_modules", "better-sqlite3");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), body);
  const onflip = path.join(root, "onflip");
  const prebuilds = path.join(onflip, "prebuilds", `${process.platform}-${process.arch}`);
  fs.mkdirSync(prebuilds, { recursive: true });
  if (prebuilt) {
    fs.writeFileSync(path.join(prebuilds, `better_sqlite3-abi${process.versions.modules}.node`), "binding");
  }
  return { engine: path.join(root, "engine"), onflip, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Exactly what Node says when a binding was built for another ABI.
const WRONG_ABI = `
module.exports = class Database {
  constructor(file, options) {
    if (!(options && options.nativeBinding && require("fs").existsSync(options.nativeBinding))) {
      throw new Error("The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127.");
    }
  }
  close() {}
};
`;

test("a Node that cannot open any shipped binding is a mismatch", { skip: needsBuild, timeout: 30_000 }, () => {
  const { probeSystemNode } = load();
  const f = fixture(WRONG_ABI);
  try {
    assert.equal(probeSystemNode(process.execPath, f.engine, f.onflip), "mismatch");
  } finally {
    f.cleanup();
  }
});

test("a shipped binding for its ABI makes it ok", { skip: needsBuild, timeout: 30_000 }, () => {
  const { probeSystemNode } = load();
  const f = fixture(WRONG_ABI, { prebuilt: true });
  try {
    assert.equal(probeSystemNode(process.execPath, f.engine, f.onflip), "ok");
  } finally {
    f.cleanup();
  }
});

test("a binding that simply loads is ok", { skip: needsBuild, timeout: 30_000 }, () => {
  const { probeSystemNode } = load();
  const f = fixture("module.exports = class Database { close() {} };");
  try {
    assert.equal(probeSystemNode(process.execPath, f.engine, f.onflip), "ok");
  } finally {
    f.cleanup();
  }
});

test("any other failure is unknown, not a mismatch", { skip: needsBuild, timeout: 30_000 }, () => {
  const { probeSystemNode } = load();
  const f = fixture('module.exports = class Database { constructor() { throw new Error("disk I/O error"); } };');
  try {
    assert.equal(probeSystemNode(process.execPath, f.engine, f.onflip), "unknown");
  } finally {
    f.cleanup();
  }
});

test("no Node at all is no-node", { skip: needsBuild, timeout: 30_000 }, () => {
  const { probeSystemNode } = load();
  const f = fixture("module.exports = class Database { close() {} };");
  try {
    assert.equal(probeSystemNode(path.join(f.engine, "no-such-node"), f.engine, f.onflip), "no-node");
  } finally {
    f.cleanup();
  }
});

test("the engine goes to Electron only when the machine's Node cannot serve it", { skip: needsBuild }, () => {
  const { engineRuntime } = load();
  assert.equal(engineRuntime(undefined, () => "ok"), "node");
  assert.equal(engineRuntime(undefined, () => "mismatch"), "electron");
  assert.equal(engineRuntime(undefined, () => "no-node"), "electron");
  assert.equal(engineRuntime(undefined, () => "unknown"), "node", "an unreadable answer keeps what came before");
  let asked = false;
  assert.equal(
    engineRuntime("C:\\node\\node.exe", () => {
      asked = true;
      return "mismatch";
    }),
    "node",
    "ONFLIP_NODE is the person's choice"
  );
  assert.equal(asked, false);
});

test("main spawns through the decision", { skip: needsBuild }, () => {
  // The call site lives in Electron's main process and cannot be loaded
  // here; checked in the source the way approval-wiring.test.js checks its.
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
  assert.match(
    main,
    /function spawnEngine\(cwd: string\): ChildProcess \{[\s\S]{0,400}if \(engineRuntimeChoice\(\) === "electron"\) return spawnEngineViaElectron\(args, cwd\);/
  );
});
