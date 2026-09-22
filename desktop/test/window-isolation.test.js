"use strict";

/**
 * Each window's agent drives its own window's browser, and nothing else.
 *
 * - The mark that identifies a window's embedded browser was one value for
 *   the whole app: every idle view sat on the same URL and an engine
 *   attached to the first page carrying it, so with two windows open,
 *   window B's agent could browse in window A's panel while its own stayed
 *   blank, and two engines could share one page.
 * - Pages the agent visited could open native popup windows without limit;
 *   Electron has no popup blocker.
 * - A stopped engine that outlived the four-second wait exited after its
 *   replacement had started, and marked that healthy engine dead.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "browser-view.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-views-"));
fs.writeFileSync(path.join(USER_DATA, "DevToolsActivePort"), "51234\n/devtools/browser/abc\n");

/** browser-view.js with Electron replaced, and the embedded browser on. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-views";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-views"] = {
    id: "electron-stub-views",
    filename: "electron-stub-views",
    loaded: true,
    exports: {
      app: { commandLine: { appendSwitch() {} }, getPath: () => USER_DATA, userAgentFallback: "" },
      BrowserWindow: class {},
      WebContentsView: class {},
    },
  };
  const previous = process.env.ONFLIP_CDP_PORT;
  delete process.env.ONFLIP_CDP_PORT;
  try {
    delete require.cache[require.resolve(DIST)];
    const mod = require(DIST);
    mod.enableEmbeddedBrowser();
    return mod;
  } finally {
    Module._resolveFilename = originalResolve;
    if (previous !== undefined) process.env.ONFLIP_CDP_PORT = previous;
  }
}

test("two windows get two marks, and each engine is told its own", { skip: needsBuild }, () => {
  const { embeddedEnv, markFor, blankUrl } = load();
  const a = {};
  const b = {};
  const envA = embeddedEnv(a);
  const envB = embeddedEnv(b);
  assert.notEqual(envA.ONFLIP_EMBEDDED_MARK, envB.ONFLIP_EMBEDDED_MARK);
  assert.equal(envA.ONFLIP_EMBEDDED_MARK, markFor(a), "a window keeps its mark");
  assert.equal(envA.ONFLIP_EMBEDDED_BLANK, blankUrl(markFor(a)));
  // The engine picks the page whose URL contains its mark: neither window's
  // mark may appear in the other's page.
  assert.ok(!blankUrl(markFor(b)).includes(markFor(a)));
  assert.ok(!blankUrl(markFor(a)).includes(markFor(b)));
  // Both still carry the app-wide part that tells them from the app's pages.
  const prefix = markFor(a).split("-")[0];
  assert.ok(markFor(b).startsWith(`${prefix}-`));
});

test("the view keeps popups to itself, and main spawns each engine with its window", { skip: needsBuild }, () => {
  // The view and the engine lifecycle live in Electron's main process and
  // cannot run here; checked in the source.
  const view = fs.readFileSync(path.join(__dirname, "..", "electron", "browser-view.ts"), "utf8");
  assert.match(view, /view\.webContents\.setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(isWebUrl\(url\)\) void view\.webContents\.loadURL\(url\);\s*return \{ action: "deny" \};/);
  assert.match(view, /loadURL\(blankUrl\(markFor\(win\)\)\)/);
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
  assert.equal((main.match(/\.\.\.embeddedEnv\(win\)/g) ?? []).length, 2);
  assert.match(main, /let child = spawnEngine\(cwd, ws\.win\);/);
  assert.match(main, /if \(ws\.engine !== c\) return;\s*ws\.engineExited = true;\s*sendTo\(ws, "engine-exit", \{ code \}\);/);
});

test("a replaced engine no longer speaks for the window", { skip: needsBuild }, () => {
  // Closing the wire stops writes, not dispatch: the old engine's shutdown
  // output set the window's folder back to the project being left and could
  // open an approval prompt whose answer went nowhere. Main-process code,
  // checked in the source.
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
  const start = main.slice(main.indexOf("function startEngine("), main.indexOf("function askRendererForApproval("));
  assert.match(start, /const current = \(\): boolean => ws\.peer === wire;/);
  assert.match(start, /wire\.onEvent = \(event, data\) => \{\s*if \(!current\(\)\) return;/);
  assert.match(start, /wire\.onRequest = async \(method, params\) => \{\s*if \(!current\(\)\) throw new Error/);
  assert.match(start, /wire\.onNoise = \(line\) => \{\s*if \(current\(\)\) sendTo/);
  // And the wire stops being current exactly when the engine is replaced.
  const stop = main.slice(main.indexOf("async function stopEngine("));
  assert.match(stop, /ws\.engine = null;\s*const wire = ws\.peer;\s*ws\.peer = null;/);
});
