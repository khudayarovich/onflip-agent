#!/usr/bin/env node
import { main } from "./cli";
import { closeBrowser } from "./chatgpt/browser-client";
import { killAllJobs } from "./tools";
import { releaseRaw } from "./ui/keys";
import * as ui from "./ui/render";
import * as screen from "./ui/screen";

/**
 * Entry point. Everything below exists so that however the process ends —
 * clean exit, signal, or crash — the terminal is left in a usable state and
 * the headless browser and background jobs are not orphaned.
 */

let shuttingDown = false;

async function cleanup(code: number): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  ui.stopSpinner();
  // Leaving the alternate buffer first means a crash message is readable in
  // the terminal the user is left looking at.
  screen.leave();
  releaseRaw();
  killAllJobs();
  await closeBrowser().catch(() => {});
  process.exit(code);
}

// The REPL handles ctrl+c itself while it owns the keyboard; this only fires
// when nothing else has claimed the signal.
process.on("SIGINT", () => void cleanup(130));
process.on("SIGTERM", () => void cleanup(143));

process.on("uncaughtException", (e) => {
  ui.stopSpinner();
  screen.leave();
  releaseRaw();
  ui.error(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  if (process.env.ONFLIP_DEBUG && e instanceof Error && e.stack) {
    process.stderr.write(`${e.stack}\n`);
  }
  void cleanup(1);
});

process.on("unhandledRejection", (reason) => {
  ui.stopSpinner();
  screen.leave();
  releaseRaw();
  ui.error(`Unexpected error: ${reason instanceof Error ? reason.message : String(reason)}`);
  if (process.env.ONFLIP_DEBUG && reason instanceof Error && reason.stack) {
    process.stderr.write(`${reason.stack}\n`);
  }
  void cleanup(1);
});

main(process.argv).catch((e) => {
  ui.stopSpinner();
  screen.leave();
  releaseRaw();
  ui.error(e instanceof Error ? e.message : String(e));
  if (process.env.ONFLIP_DEBUG && e instanceof Error && e.stack) {
    process.stderr.write(`${e.stack}\n`);
  }
  void cleanup(1);
});
