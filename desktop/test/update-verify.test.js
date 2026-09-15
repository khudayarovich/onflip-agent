"use strict";

/**
 * Holding a downloaded update against the checksum its release published.
 *
 * From an external security audit of the shipped build: the updater checked
 * only `Content-Length` before unpacking an archive and replacing the
 * application. Length is not content — a file of the right size is not the
 * right file.
 *
 * What this does and does not cover is worth keeping straight, because the
 * listing lives in the same release as the artifact: anyone able to swap one
 * could swap both, so it is no defence against a compromised release. It
 * catches a truncated or corrupted download, a proxy serving something else,
 * and an artifact from a different release. The real defence is a signature
 * made with a key that is not in the release, which needs a certificate this
 * project does not have.
 *
 * The listing format is whatever `sha256sum` and `shasum -a 256` emit, which
 * is what the release workflow runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "update-install.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/**
 * The module reaches for Electron at the top; only pure exports are used.
 *
 * Without this the file loaded the real `electron` package, which works on a
 * machine that has run the app and throws everywhere else. CI installs with
 * `--ignore-scripts`, so Electron's binary is never downloaded and
 * `require("electron")` raises "Electron failed to install correctly" - eight
 * failures, none of them about checksums.
 *
 * It went unnoticed for six releases because every other desktop test that
 * loads from `dist/electron` already stubs it, and the machine this was
 * written on has Electron installed. build-guards.test.js now checks the
 * rule rather than leaving it to be remembered.
 */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-verify";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-verify"] = {
    id: "electron-stub-verify",
    filename: "electron-stub-verify",
    loaded: true,
    exports: { app: { getPath: () => "", getVersion: () => "0.0.0", quit() {} }, net: {} },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

// Exactly what the release workflow writes, two spaces and all.
const LISTING = [
  "9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f  OnFlip-0.10.31-mac-arm64.dmg",
  "1111111122222222333333334444444455555555666666667777777788888888  OnFlip-0.10.31-mac-arm64.zip",
  "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000_1111111  not-a-digest.zip",
].join("\n");

test("the digest for a named file is found", { skip: needsBuild }, () => {
  const { sumFor } = load();
  assert.equal(
    sumFor(LISTING, "OnFlip-0.10.31-mac-arm64.zip"),
    "1111111122222222333333334444444455555555666666667777777788888888"
  );
});

test("a file the listing does not name has no digest", { skip: needsBuild }, () => {
  // Not the same as a mismatch. A release that never published a sum for this
  // artifact has nothing to disagree with, and refusing it would strand
  // anyone on an older build rather than protect them.
  const { sumFor } = load();
  assert.equal(sumFor(LISTING, "OnFlip-Setup-0.10.31.exe"), null);
});

test("a malformed line is not mistaken for a digest", { skip: needsBuild }, () => {
  const { sumFor } = load();
  assert.equal(sumFor(LISTING, "not-a-digest.zip"), null);
});

test("an empty or missing listing yields nothing rather than throwing", { skip: needsBuild }, () => {
  const { sumFor } = load();
  assert.equal(sumFor("", "anything.zip"), null);
  assert.equal(sumFor(undefined, "anything.zip"), null);
});

test("the binary-mode marker and a path prefix are both tolerated", { skip: needsBuild }, () => {
  // `sha256sum -b` writes an asterisk before the name, and some tools write a
  // path. Only the base name is ever compared.
  const { sumFor } = load();
  const listing =
    "0000000011111111222222223333333344444444555555556666666677777777 *dist/OnFlip-Setup-1.0.0.exe";
  assert.equal(
    sumFor(listing, "OnFlip-Setup-1.0.0.exe"),
    "0000000011111111222222223333333344444444555555556666666677777777"
  );
});

test("the digest of a real file on disk is computed", { skip: needsBuild }, async () => {
  const { sha256File } = load();
  const tmp = path.join(require("node:os").tmpdir(), `onflip-sum-${process.pid}`);
  fs.writeFileSync(tmp, "abc");
  try {
    // The published SHA-256 of "abc".
    assert.equal(
      await sha256File(tmp),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("a file that does not match the published digest is refused", { skip: needsBuild }, async () => {
  // The whole point: a mismatch must stop the install, not warn about it.
  const { verifyDownload } = load();
  const tmp = path.join(require("node:os").tmpdir(), `onflip-bad-${process.pid}`);
  fs.writeFileSync(tmp, "tampered");
  try {
    await assert.rejects(
      () =>
        verifyDownload(
          tmp,
          "thing.zip",
          "about:listing",
          () => {},
          async () => "0000000000000000000000000000000000000000000000000000000000000000  thing.zip"
        ),
      /does not match the checksum/
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("a matching file is allowed through", { skip: needsBuild }, async () => {
  const { verifyDownload, sha256File } = load();
  const tmp = path.join(require("node:os").tmpdir(), `onflip-good-${process.pid}`);
  fs.writeFileSync(tmp, "abc");
  try {
    const digest = await sha256File(tmp);
    const notes = [];
    await verifyDownload(tmp, "thing.zip", "about:listing", (l) => notes.push(l), async () => `${digest}  thing.zip`);
    assert.ok(notes.some((l) => /checksum verified/.test(l)), notes.join(" | "));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
