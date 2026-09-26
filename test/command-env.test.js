"use strict";

/**
 * A command the agent runs does not inherit ELECTRON_RUN_AS_NODE.
 *
 * The desktop app runs the engine under Electron-as-Node when the machine's
 * own Node cannot load the sqlite binding it ships, and every command the
 * engine started inherited the variable: an Electron app the user asked to
 * have built and run came up as a bare Node process instead, with nothing on
 * screen to say why.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { bashTool, commandEnv } = require("../dist/tools/shell");

const windows = process.platform === "win32";

test("the command environment leaves ELECTRON_RUN_AS_NODE out", () => {
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const env = commandEnv();
    assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
    assert.equal(env.ONFLIP, "1");
    assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, "everything else is inherited");
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
});

test("nor Node's test-runner channel, which turns a failing `node --test` into a pass", () => {
  // Found running this suite: OnFlip's own check of the work ran `node
  // --test` from inside a test process, the child inherited the runner's
  // variable, went into child mode, and reported a failing test as passing.
  const had = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = had ?? "child-v8";
  try {
    assert.equal("NODE_TEST_CONTEXT" in commandEnv(), false);
  } finally {
    if (had === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = had;
  }
});

test("and a real command does not see it", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-cmd-env-"));
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const result = await bashTool.run(
      {
        command: windows ? 'Write-Output "[$env:ELECTRON_RUN_AS_NODE]"' : 'echo "[$ELECTRON_RUN_AS_NODE]"',
        description: "test",
      },
      {
        cwd: dir,
        session: { readFiles: new Map(), snapshots: [] },
        requestPermission: async () => ({ allow: true }),
        signal: new AbortController().signal,
      }
    );
    assert.match(result.output, /\[\]/, result.output);
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
