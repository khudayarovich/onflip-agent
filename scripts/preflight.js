#!/usr/bin/env node
"use strict";

/**
 * Run what CI runs, before pushing the tag rather than after.
 *
 * `ci.yml` has two job shapes and they fail differently. Checking one and
 * assuming the other is how the desktop job stayed red for six releases
 * while the suite passed locally every single time:
 *
 *   engine · node 20/22 on ubuntu|macos|windows
 *       builds only `src/`, runs `node --test`. Desktop tests must SKIP
 *       here, through their `needsBuild` guard. Reproduced by moving
 *       `desktop/dist` aside.
 *
 *   desktop app · ubuntu
 *       installs both packages with `npm ci --ignore-scripts`, builds both,
 *       runs the whole suite. This is the only job that actually executes
 *       the desktop tests. `--ignore-scripts` means Electron's binary is
 *       never downloaded, so `require("electron")` throws there and works
 *       here. Reproduced by moving `node_modules/electron/path.txt` aside,
 *       which is exactly the state CI is in.
 *
 * Both shapes, both restored whatever happens, and a non-zero exit if
 * either fails. Nothing here talks to the network, so it is also the
 * fastest way to be sure a change is safe on a plane.
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DESKTOP_DIST = path.join(ROOT, "desktop", "dist");
const ELECTRON_PATH = path.join(ROOT, "desktop", "node_modules", "electron", "path.txt");

/** Moves a path aside and always puts it back, even if the body throws. */
function withHidden(target, body) {
  const away = `${target}.preflight-away`;
  const present = fs.existsSync(target);
  if (present) fs.renameSync(target, away);
  try {
    return body();
  } finally {
    if (present && fs.existsSync(away)) fs.renameSync(away, target);
  }
}

function run(command, cwd = ROOT) {
  execSync(command, { cwd, stdio: "inherit" });
}

function stage(name, body) {
  process.stdout.write(`\n── ${name}\n`);
  try {
    body();
    process.stdout.write(`   ok: ${name}\n`);
    return true;
  } catch {
    process.stdout.write(`   FAILED: ${name}\n`);
    return false;
  }
}

const results = [];

results.push(
  stage("build (engine, then desktop)", () => {
    run("npm run build");
    run("npm run build:node", path.join(ROOT, "desktop"));
    run("npm run build:ui", path.join(ROOT, "desktop"));
  })
);

results.push(
  stage("typecheck (desktop main, engine and renderer)", () => {
    run("npm run typecheck", path.join(ROOT, "desktop"));
  })
);

results.push(
  stage("desktop app job — whole suite, Electron uninstalled", () => {
    withHidden(ELECTRON_PATH, () => run("node --test"));
  })
);

results.push(
  stage("engine job — suite with desktop/dist absent", () => {
    withHidden(DESKTOP_DIST, () => run("npm run test:only"));
  })
);

const failed = results.filter((ok) => !ok).length;
process.stdout.write(
  failed === 0
    ? "\npreflight: every stage passed; both CI job shapes are green here.\n"
    : `\npreflight: ${failed} stage(s) failed. Do not tag.\n`
);
process.exit(failed === 0 ? 0 : 1);
