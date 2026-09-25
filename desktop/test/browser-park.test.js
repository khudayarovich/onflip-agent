"use strict";

/**
 * The agent's browser stays usable while the panel is closed.
 *
 * Read from this project's own machine on 0.10.60: with the Browser panel
 * never opened, every click the agent made waited out Playwright's fifteen
 * seconds (ten times) and every screenshot failed with "Cannot take
 * screenshot with 0 width" (seven times), because the page had been given
 * no size at all. The agent was checking the chess animation it had just
 * written, could not see it, and the person saw "nothing changed".
 *
 * Measured in Electron itself (see `parkView`): a page takes its size from
 * the view only while part of the view is inside the window, so the view
 * waits at a real size with exactly one pixel in the window's top-left
 * corner. These tests hold that geometry; the behaviour behind it was
 * checked against the real thing.
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

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-park-"));

class FakeContents {
  constructor() {
    this.focused = false;
    this.debugger = { isAttached: () => true, attach() {}, sendCommand: async () => ({}) };
    this.session = { setUserAgent() {}, webRequest: { onBeforeSendHeaders() {} } };
  }
  setUserAgent() {}
  on() {}
  setWindowOpenHandler() {}
  loadURL() {
    return Promise.resolve();
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return this.focused;
  }
  close() {}
}

/** A native view that records what it was told. */
class FakeView {
  constructor() {
    this.webContents = new FakeContents();
    this.bounds = null;
    this.visible = true;
  }
  setBackgroundColor() {}
  setBounds(bounds) {
    this.bounds = bounds;
  }
  setVisible(visible) {
    this.visible = visible;
  }
}

/** browser-view.js with Electron replaced, and the embedded browser on. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-park";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-park"] = {
    id: "electron-stub-park",
    filename: "electron-stub-park",
    loaded: true,
    exports: {
      app: {
        commandLine: { appendSwitch() {} },
        getPath: () => USER_DATA,
        userAgentFallback:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OnFlip/0.10.62 Chrome/140.0.0.0 Electron/42.0.0 Safari/537.36",
      },
      BrowserWindow: class {},
      WebContentsView: FakeView,
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    const mod = require(DIST);
    mod.enableEmbeddedBrowser();
    return mod;
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

function fakeWindow() {
  const win = {
    focusedBack: false,
    contentView: { addChildView() {} },
    once() {},
    isDestroyed: () => false,
    webContents: {
      focus() {
        win.focusedBack = true;
      },
    },
  };
  return win;
}

/** Exactly one pixel of the view inside the window, in its top-left corner. */
function onePixelIn(bounds) {
  return bounds.x + bounds.width === 1 && bounds.y + bounds.height === 1;
}

test("a view no panel has shown yet waits at a size a page can be used at, one pixel on screen", { skip: needsBuild }, () => {
  const { ensureView } = load();
  const win = fakeWindow();
  const view = ensureView(win);
  assert.ok(view, "the embedded browser is on");
  assert.equal(view.visible, true, "hidden, it draws nothing and its animations stand still");
  assert.ok(view.bounds.width >= 800 && view.bounds.height >= 600, JSON.stringify(view.bounds));
  assert.ok(onePixelIn(view.bounds), JSON.stringify(view.bounds));
});

test("closing the panel parks the page at the size it was shown at, still drawing, and hands back the keyboard", { skip: needsBuild }, () => {
  const { ensureView, setViewBounds, hideView } = load();
  const win = fakeWindow();
  const view = ensureView(win);
  setViewBounds(win, { x: 1100, y: 64, width: 459, height: 763 });
  assert.deepEqual(view.bounds, { x: 1100, y: 64, width: 459, height: 763 });
  view.webContents.focused = true;
  hideView(win);
  assert.deepEqual(
    { width: view.bounds.width, height: view.bounds.height },
    { width: 459, height: 763 },
    "the same size, so the page does not reflow when the panel opens again"
  );
  assert.ok(onePixelIn(view.bounds), JSON.stringify(view.bounds));
  assert.equal(view.visible, true);
  assert.equal(win.focusedBack, true, "typing meant for the composer does not go to a page nobody can see");
});

test("a rectangle mid-animation is not taken for the panel's size", { skip: needsBuild }, () => {
  const { ensureView, setViewBounds, hideView } = load();
  const win = fakeWindow();
  const view = ensureView(win);
  setViewBounds(win, { x: 1500, y: 64, width: 3, height: 763 });
  hideView(win);
  assert.ok(view.bounds.width >= 800, `parked ${view.bounds.width} wide`);
  assert.ok(onePixelIn(view.bounds), JSON.stringify(view.bounds));
});
