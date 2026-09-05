"use strict";

/**
 * What the address bar does with what you typed.
 *
 * People type "example.com", not "https://example.com", and they type
 * "localhost:3000" far more often than either. Getting the scheme wrong is
 * not a cosmetic slip: sending a local dev server to https produces an error
 * page, which reads as the browser being broken rather than the guess being
 * wrong. Found exactly that way — typing 127.0.0.1:55377 opened
 * https://127.0.0.1:55377 and loaded nothing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "browser-view.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/** The module reaches for Electron at the top; only pure exports are used. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-url";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-url"] = {
    id: "electron-stub-url",
    filename: "electron-stub-url",
    loaded: true,
    exports: {
      app: { commandLine: { appendSwitch() {} }, getPath: () => "", userAgentFallback: "" },
      BrowserWindow: class {},
      WebContentsView: class {},
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

test("a full URL is left exactly as it is", { skip: needsBuild }, () => {
  const { normaliseUrl } = load();

  assert.equal(normaliseUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(normaliseUrl("http://example.com"), "http://example.com");
  assert.equal(normaliseUrl("about:blank"), "about:blank");
  assert.equal(normaliseUrl("file:///C:/x.html"), "file:///C:/x.html");
});

test("a local dev server goes to http, not https", { skip: needsBuild }, () => {
  // The bug this file exists for. "127.0.0.1:5173" is word characters
  // separated by dots, so a general host rule matches it first and sends a
  // plain-http dev server to https — which serves nothing.
  const { normaliseUrl } = load();

  assert.equal(normaliseUrl("127.0.0.1:55377/one"), "http://127.0.0.1:55377/one");
  assert.equal(normaliseUrl("127.0.0.1"), "http://127.0.0.1");
  assert.equal(normaliseUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normaliseUrl("localhost"), "http://localhost");
  assert.equal(normaliseUrl("192.168.1.10:8080/admin"), "http://192.168.1.10:8080/admin");
});

test("a bare hostname goes to https", { skip: needsBuild }, () => {
  const { normaliseUrl } = load();

  assert.equal(normaliseUrl("example.com"), "https://example.com");
  assert.equal(normaliseUrl("docs.example.com/guide"), "https://docs.example.com/guide");
});

test("anything that is not an address is searched for", { skip: needsBuild }, () => {
  // An address bar that answers a question with an error page is worse than
  // one that answers it with results.
  const { normaliseUrl } = load();

  assert.match(normaliseUrl("how to centre a div"), /duckduckgo\.com\/\?q=/);
  assert.match(normaliseUrl("how to centre a div"), /how%20to%20centre%20a%20div/);
});

test("surrounding whitespace is not an address", { skip: needsBuild }, () => {
  const { normaliseUrl } = load();

  assert.equal(normaliseUrl("  example.com  "), "https://example.com");
});

test("an empty bar goes nowhere rather than searching for nothing", { skip: needsBuild }, () => {
  const { normaliseUrl } = load();

  assert.equal(normaliseUrl(""), "about:blank");
  assert.equal(normaliseUrl("   "), "about:blank");
});
