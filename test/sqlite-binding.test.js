"use strict";

/**
 * A sqlite binding that cannot run here falls back to the shipped one —
 * whether it was built for another ABI or for another CPU.
 *
 * The macOS release is built on Apple Silicon, so the Intel app's default
 * binding is arm64 (read out of the 0.10.55 zips; the same back to at least
 * 0.10.40). On an Intel Mac that load fails with "incompatible
 * architecture" before any ABI is compared, and the fallback only knew the
 * ABI wording, so the darwin-x64 binding the app ships was never tried:
 * usage counts read zero and importing a session from Chrome or Firefox
 * failed. The wordings below are the loaders' own.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { isBindingMismatch, withBundledBinding, BINDING_MISMATCH } = require("../dist/auth/sqlite-binding");

const MAC_INTEL =
  "dlopen(/Applications/OnFlip.app/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node, 0x0001): " +
  "tried: '/Applications/OnFlip.app/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
  "(mach-o file, but is an incompatible architecture (have 'arm64', need 'x86_64h' or 'x86_64'))";
const MAC_OLDER =
  "dlopen(/x/better_sqlite3.node, 1): no suitable image found.  Did find:\n\t/x/better_sqlite3.node: mach-o, but wrong architecture";
const WINDOWS = "\\\\?\\C:\\app\\better_sqlite3.node is not a valid Win32 application.";
const LINUX = "/app/better_sqlite3.node: wrong ELF class: ELFCLASS32";
const WRONG_ABI =
  "The module '/app/better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 146.";

test("a binding built for another CPU is recognised, in every loader's words", () => {
  for (const [where, message] of Object.entries({ MAC_INTEL, MAC_OLDER, WINDOWS, LINUX })) {
    assert.equal(isBindingMismatch(new Error(message)), true, where);
  }
});

test("and so, still, is one built for another ABI", () => {
  assert.equal(isBindingMismatch(new Error(WRONG_ABI)), true);
  assert.equal(isBindingMismatch("was compiled against a different Node.js version"), true, "a bare string");
});

test("sqlite failing on a database is not the binding refusing the runtime", () => {
  for (const message of [
    "SQLITE_CANTOPEN: unable to open database file",
    "database is locked",
    "ENOENT: no such file or directory, open '/x/Cookies'",
    "file is not a database",
    "disk I/O error",
    "",
  ]) {
    assert.equal(isBindingMismatch(new Error(message)), false, message || "(empty)");
  }
  assert.equal(isBindingMismatch(undefined), false);
});

test("the default binding refused for its CPU: the shipped one is opened instead", () => {
  const opened = [];
  const db = withBundledBinding(
    (nativeBinding) => {
      opened.push(nativeBinding ?? "default");
      if (!nativeBinding) throw new Error(MAC_INTEL);
      return { binding: nativeBinding };
    },
    () => "/app/node_modules/onflip/prebuilds/darwin-x64/better_sqlite3-abi146.node"
  );
  assert.deepEqual(opened, ["default", "/app/node_modules/onflip/prebuilds/darwin-x64/better_sqlite3-abi146.node"]);
  assert.equal(db.binding, "/app/node_modules/onflip/prebuilds/darwin-x64/better_sqlite3-abi146.node");
});

test("a default binding that loads is used, and nothing shipped is looked for", () => {
  let asked = false;
  const db = withBundledBinding(
    (nativeBinding) => ({ binding: nativeBinding ?? "default" }),
    () => {
      asked = true;
      return "/shipped.node";
    }
  );
  assert.equal(db.binding, "default");
  assert.equal(asked, false);
});

test("any other failure is sqlite's answer and is passed on untouched", () => {
  const locked = new Error("database is locked");
  let asked = false;
  assert.throws(
    () =>
      withBundledBinding(
        () => {
          throw locked;
        },
        () => {
          asked = true;
          return "/shipped.node";
        }
      ),
    (e) => e === locked
  );
  assert.equal(asked, false, "no binding swap for a database problem");
});

test("with nothing shipped for this runtime, the original refusal is what is reported", () => {
  const refused = new Error(MAC_INTEL);
  assert.throws(
    () =>
      withBundledBinding(
        () => {
          throw refused;
        },
        () => null
      ),
    (e) => e === refused
  );
});

test("the pattern is one literal the runtime probe can carry into another process", () => {
  // engine-runtime.ts pastes it into a program run under the machine's own
  // Node, so it has to survive being turned back into source.
  const again = eval(String(BINDING_MISMATCH));
  assert.equal(again.test(MAC_INTEL), true);
  assert.equal(again.test("database is locked"), false);
});
