"use strict";

/**
 * Opening a browser's cookie database on a runtime the default binding
 * cannot serve.
 *
 * better-sqlite3 is replaced by a stand-in that refuses to load the way
 * macOS refuses the Apple Silicon binding on an Intel Mac, so this runs on
 * any machine. With the old ABI-only test the raw loader error came straight
 * through — "mach-o file, but is an incompatible architecture" in the middle
 * of a sign-in — and the cookie reader never read it as its own runtime's
 * failure.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const WRONG_CPU =
  "dlopen(/x/better_sqlite3.node, 0x0001): tried: '/x/better_sqlite3.node' (mach-o file, but is an incompatible architecture (have 'arm64', need 'x86_64'))";

const opened = [];
class FakeDatabase {
  constructor(file, options) {
    opened.push(options && options.nativeBinding ? "shipped" : "default");
    if (!(options && options.nativeBinding)) throw new Error(WRONG_CPU);
    this.file = file;
  }
}
const key = require.resolve("better-sqlite3", { paths: [require("node:path").join(__dirname, "..", "dist", "auth")] });
require.cache[key] = { id: key, filename: key, loaded: true, exports: FakeDatabase };

const { openCookieDb } = require("../dist/auth/session");
const { bindingMismatch } = require("../dist/auth/extract");
const { bundledSqliteBinding } = require("../dist/auth/sqlite-binding");

test("a binding refused for its CPU is reported as the runtime's, in words the reader knows", () => {
  opened.length = 0;
  let error;
  try {
    openCookieDb("/profile/Cookies");
  } catch (e) {
    error = e;
  }
  if (bundledSqliteBinding()) {
    // This runtime has a shipped binding (an Electron ABI): it was used.
    assert.deepEqual(opened, ["default", "shipped"]);
    return;
  }
  assert.ok(error, "nothing shipped for this test runtime, so the open fails");
  assert.deepEqual(opened, ["default"]);
  assert.match(error.message, /^the sqlite binding does not match this runtime \(\w+-\w+, ABI \d+\)/);
  assert.equal(bindingMismatch(error.message), true, "which the cookie reader takes as this runtime failing, not as no session");
});
