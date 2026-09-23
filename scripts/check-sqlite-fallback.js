#!/usr/bin/env node
/**
 * Open sqlite the way OnFlip does, in this process, and say which binding
 * answered.
 *
 *   node scripts/check-sqlite-fallback.js [onflip-package-dir] [--expect-fallback]
 *
 * Its reason to exist is the Intel Mac. The macOS release is built on Apple
 * Silicon, so the Intel app's default binding is arm64, and on an Intel Mac
 * only the shipped darwin-x64 binding in prebuilds/ can open anything. No
 * Intel Mac is at hand, but an Apple Silicon one runs the Intel build under
 * Rosetta, where the arm64 binding fails exactly as it does on the real
 * thing — so CI runs this under the x64 Electron, and the release runs it
 * inside each Mac build it is about to publish.
 *
 * The package directory defaults to this repository; point it at
 * `OnFlip.app/Contents/Resources/app/node_modules/onflip` to check a build.
 * `--expect-fallback` fails the run unless the default binding was refused
 * for this runtime and the shipped one took over — the proof that the
 * reproduction reproduced something.
 */
"use strict";

const path = require("node:path");

const args = process.argv.slice(2);
const expectFallback = args.includes("--expect-fallback");
const onflip = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(__dirname, ".."));

const { withBundledBinding, isBindingMismatch } = require(path.join(onflip, "dist", "auth", "sqlite-binding.js"));
const Database = require(require.resolve("better-sqlite3", { paths: [onflip] }));

let refused = null;
try {
  new Database(":memory:").close();
} catch (e) {
  refused = e;
}

let used = "default";
const db = withBundledBinding((nativeBinding) => {
  if (nativeBinding) used = path.relative(onflip, nativeBinding);
  return new Database(":memory:", nativeBinding ? { nativeBinding } : {});
});
const sqlite = db.prepare("select sqlite_version() as v").get().v;
db.close();

console.log(
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
      electron: process.versions.electron || null,
      defaultBinding: refused ? `refused: ${String(refused.message).slice(0, 240)}` : "loaded",
      answeredBy: used,
      sqlite,
    },
    null,
    2
  )
);

if (expectFallback && !(refused && isBindingMismatch(refused) && used !== "default")) {
  console.error(
    "Expected the default binding to be refused by this runtime and the shipped one to take over; " +
      (refused ? `the default failed with something else: ${refused.message}` : "the default binding loaded.")
  );
  process.exit(1);
}
