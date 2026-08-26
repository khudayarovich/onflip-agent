#!/usr/bin/env node
/**
 * Fetch the Chromium build OnFlip falls back to.
 *
 * Playwright stopped downloading browsers from its own postinstall, so without
 * this a global install finishes "successfully" and then fails on the first
 * turn with a message about a missing executable. OnFlip prefers the real
 * installed Chrome and only reaches for this build when there is none — but
 * "only sometimes needed" is not a reason to make the first run fail.
 *
 * Never fatal. A download that fails must not take the install down with it:
 * the CLI is still installed, and `onflip status` shows what it found.
 */
const { spawnSync } = require("node:child_process");

const SKIP = process.env.ONFLIP_SKIP_BROWSER_DOWNLOAD;

function note(message) {
  process.stdout.write(`onflip: ${message}\n`);
}

if (SKIP && SKIP !== "0" && SKIP !== "false") {
  note("skipping the Chromium download (ONFLIP_SKIP_BROWSER_DOWNLOAD is set).");
  process.exit(0);
}

let cli;
try {
  cli = require.resolve("playwright/cli.js");
} catch {
  // Dependencies are not in place — an --ignore-scripts install, or a tree
  // that was never installed. Nothing to do, and nothing worth failing over.
  note("playwright is not installed yet; run `npx playwright install chromium` once it is.");
  process.exit(0);
}

note("fetching the Chromium build Playwright falls back to (one time, ~150 MB)…");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
  stdio: "inherit",
});

if (result.status !== 0) {
  note("that download did not finish. OnFlip still works if Chrome is installed;");
  note("otherwise run `npx playwright install chromium` when you have a moment.");
}
process.exit(0);
