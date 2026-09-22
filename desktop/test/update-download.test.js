"use strict";

/**
 * Downloading an update ends — one way or the other — and the installer it
 * hands off to brings the app back.
 *
 * - The file stream had no `error` listener: a full disk, an antivirus lock
 *   or a vanished folder was an uncaught exception in the main process and
 *   a promise that never settled, so the modal sat on "downloading".
 * - Nothing timed out. A connection that stopped sending left the download
 *   running for ever, with the button disabled behind it.
 * - The Windows installer ran with `/S` alone, and a silent electron-builder
 *   install starts the app again only when given `--force-run`: the update
 *   installed and the app never came back.
 *
 * Electron's `net` is replaced by a scripted one, so what is tested is this
 * module's handling of the events, not a network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const DIST = path.join(__dirname, "..", "dist", "electron", "update-install.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-update-dl-"));

/**
 * A request whose response is driven by `script(response, request)`.
 *
 * `sync` answers inside `request.end()`, before the file has finished
 * opening — which decides the order a failed write reports in: the stream's
 * `end` callback first, then its `error` event. Answering a tick later
 * gives the other order. Both have to reject.
 */
function scriptedNet(script, { sync = false } = {}) {
  const made = [];
  return {
    made,
    request() {
      const request = new EventEmitter();
      request.aborted = false;
      request.setHeader = () => {};
      request.abort = () => {
        request.aborted = true;
      };
      request.end = () => {
        const answer = () => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = { "content-length": "12" };
          response.pause = () => {};
          response.resume = () => {};
          request.emit("response", response);
          script(response, request);
        };
        if (sync) answer();
        else setImmediate(answer);
      };
      made.push(request);
      return request;
    },
  };
}

function load(net) {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-download";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-download"] = {
    id: "electron-stub-download",
    filename: "electron-stub-download",
    loaded: true,
    exports: {
      app: { getPath: () => TEMP, getVersion: () => "0.0.0", getAppPath: () => TEMP, quit() {} },
      net,
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

const threeChunks = (response) => {
  for (const c of ["abcd", "efgh", "ijkl"]) response.emit("data", Buffer.from(c));
  response.emit("end");
};

test("a complete download resolves to the file", { skip: needsBuild, timeout: 10_000 }, async () => {
  // The false-positive half: the new guards leave a good download alone.
  const { downloadUpdate } = load(scriptedNet(threeChunks));
  const file = await downloadUpdate("https://example.invalid/x", "OnFlip-Setup.exe", () => {});
  assert.equal(fs.readFileSync(file, "utf8"), "abcdefghijkl");
});

test("a download that cannot be written fails instead of crashing", { skip: needsBuild, timeout: 10_000 }, async () => {
  // The folder under the name does not exist: the same path as a full disk
  // or a locked file, as far as the stream is concerned. The end arrives
  // after the open has failed, so the stream's `error` event comes first.
  const late = (response) => {
    response.emit("data", Buffer.from("abcd"));
    setTimeout(() => {
      response.emit("data", Buffer.from("efghijkl"));
      response.emit("end");
    }, 100);
  };
  const { downloadUpdate } = load(scriptedNet(late));
  await assert.rejects(
    () => downloadUpdate("https://example.invalid/x", "missing-dir/OnFlip-Setup.exe", () => {}),
    /ENOENT|no such file/i
  );
});

test("and so does one whose failure reaches the end callback first", { skip: needsBuild, timeout: 10_000 }, async () => {
  // Everything written and ended before the file finished opening: the
  // failure is handed to `end`'s callback, and ignoring its argument
  // resolved the download as if the installer were on disk.
  const { downloadUpdate } = load(scriptedNet(threeChunks, { sync: true }));
  await assert.rejects(
    () => downloadUpdate("https://example.invalid/x", "missing-dir/OnFlip-Setup.exe", () => {}),
    /ENOENT|no such file/i
  );
});

test("a download that stops sending is called stalled", { skip: needsBuild, timeout: 10_000 }, async () => {
  process.env.ONFLIP_UPDATE_STALL_MS = "150";
  try {
    const net = scriptedNet((response) => response.emit("data", Buffer.from("abcd")));
    const { downloadUpdate } = load(net);
    const started = Date.now();
    await assert.rejects(
      () => downloadUpdate("https://example.invalid/x", "OnFlip-Setup.exe", () => {}),
      /stalled/
    );
    assert.ok(Date.now() - started < 5_000, "the stall was not noticed");
    assert.equal(net.made[0].aborted, true, "the stalled request was left open");
  } finally {
    delete process.env.ONFLIP_UPDATE_STALL_MS;
  }
});

test("so is one that never answers at all", { skip: needsBuild, timeout: 10_000 }, async () => {
  process.env.ONFLIP_UPDATE_STALL_MS = "150";
  try {
    const silent = {
      request() {
        const request = new EventEmitter();
        request.setHeader = () => {};
        request.abort = () => {};
        request.end = () => {};
        return request;
      },
    };
    const { downloadUpdate } = load(silent);
    await assert.rejects(() => downloadUpdate("https://example.invalid/x", "OnFlip-Setup.exe", () => {}), /stalled/);
  } finally {
    delete process.env.ONFLIP_UPDATE_STALL_MS;
  }
});

test("but a slow download that keeps arriving is not a stall", { skip: needsBuild, timeout: 10_000 }, async () => {
  // The limit is on silence, not on the whole download: a slow line that
  // is still delivering must be allowed to finish.
  process.env.ONFLIP_UPDATE_STALL_MS = "150";
  try {
    const trickle = (response) => {
      const chunks = ["abc", "def", "ghi", "jkl"];
      const next = () => {
        const chunk = chunks.shift();
        if (!chunk) return response.emit("end");
        response.emit("data", Buffer.from(chunk));
        setTimeout(next, 90);
      };
      next();
    };
    const { downloadUpdate } = load(scriptedNet(trickle));
    const file = await downloadUpdate("https://example.invalid/x", "OnFlip-Setup.exe", () => {});
    assert.equal(fs.readFileSync(file, "utf8"), "abcdefghijkl");
  } finally {
    delete process.env.ONFLIP_UPDATE_STALL_MS;
  }
});

/** Run applyUpdate as Windows, with a spawn that does what `outcome` says. */
async function applyOnWindows(applyUpdate, outcome) {
  const cp = require("node:child_process");
  const realSpawn = cp.spawn;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const spawned = [];
  cp.spawn = (file, args) => {
    const child = new EventEmitter();
    child.unref = () => {};
    spawned.push({ file, args });
    setImmediate(() =>
      outcome === "spawn" ? child.emit("spawn") : child.emit("error", Object.assign(new Error("Access is denied."), { code: "EPERM" }))
    );
    return child;
  };
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    return { result: await applyUpdate("C:\\temp\\OnFlip-Setup.exe"), spawned };
  } finally {
    cp.spawn = realSpawn;
    Object.defineProperty(process, "platform", platform);
  }
}

test("the Windows installer is told to start the app again", { skip: needsBuild, timeout: 10_000 }, async () => {
  const { WINDOWS_INSTALLER_ARGS, applyUpdate } = load(scriptedNet(threeChunks));
  assert.ok(WINDOWS_INSTALLER_ARGS.includes("/S"));
  assert.ok(WINDOWS_INSTALLER_ARGS.includes("--force-run"));
  const { result, spawned } = await applyOnWindows(applyUpdate, "spawn");
  assert.deepEqual(result, { relaunches: true });
  assert.deepEqual(spawned, [{ file: "C:\\temp\\OnFlip-Setup.exe", args: WINDOWS_INSTALLER_ARGS }]);
});

test("an installer the system refuses to start is reported, not quit on", { skip: needsBuild, timeout: 10_000 }, async () => {
  // It was reported started the moment spawn returned and the app quit a
  // second later; an antivirus holding the unsigned exe meant an uncaught
  // exception and an app that closed with no update behind it.
  const { applyUpdate } = load(scriptedNet(threeChunks));
  await assert.rejects(() => applyOnWindows(applyUpdate, "error"), /the installer could not be started: Access is denied/);
});
