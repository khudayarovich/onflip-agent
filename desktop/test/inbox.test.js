"use strict";

/**
 * Files sent *to* the bot, and where they are allowed to land.
 *
 * The name on an incoming file is not OnFlip's: it is text the sender typed,
 * arriving over the network, about to be used as a path. `..\\..\\.onflip\\config.json`
 * is a perfectly valid Telegram document name. So the tests that matter here
 * are the ones about what a name cannot do, and about never quietly replacing
 * a file that is already there.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "shared", "inbox.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const load = () => require(DIST);

const DIR = path.join("C:", "inbox");
const never = () => false;

// --- a name from a stranger cannot become a path ----------------------------

test("a name that climbs out of the folder is reduced to its last part", { skip: needsBuild }, () => {
  const { safeFileName } = load();

  assert.equal(safeFileName("../../.onflip/config.json"), "config.json");
  assert.equal(safeFileName("..\\..\\.onflip\\config.json"), "config.json");
  assert.equal(safeFileName("/etc/passwd"), "passwd");
});

test("and the target stays inside the inbox whatever the name was", { skip: needsBuild }, () => {
  const { inboxTarget } = load();
  const file = inboxTarget(DIR, "../../secrets.env", "bin", never);

  assert.equal(path.dirname(file), DIR);
  assert.ok(!file.includes(".."));
});

test("dots and separators alone leave nothing, so the file is named for us", { skip: needsBuild }, () => {
  const { safeFileName, inboxTarget } = load();

  assert.equal(safeFileName(".."), null);
  assert.equal(safeFileName("/"), null);
  assert.equal(safeFileName(""), null);

  const stamp = new Date("2026-09-07T08:15:30Z");
  const file = inboxTarget(DIR, "", "jpg", never, stamp);
  assert.match(path.basename(file), /^telegram-2026-09-07_08-15-30\.jpg$/);
});

test("control characters are stripped, not turned into dashes to be read later", { skip: needsBuild }, () => {
  const { safeFileName } = load();
  assert.equal(safeFileName("re\u0000port\u001f.pdf"), "report.pdf");
});

test("an ordinary name survives intact", { skip: needsBuild }, () => {
  const { safeFileName } = load();
  assert.equal(safeFileName("Q3 report (final).pdf"), "Q3 report -final-.pdf");
  assert.equal(safeFileName("notes.md"), "notes.md");
});

// --- and nothing is ever replaced -------------------------------------------

test("a second file with the same name is numbered, not written over", { skip: needsBuild }, () => {
  const { inboxTarget } = load();
  const taken = new Set([path.join(DIR, "report.pdf"), path.join(DIR, "report-2.pdf")]);

  const file = inboxTarget(DIR, "report.pdf", "bin", (f) => taken.has(f));
  assert.equal(path.basename(file), "report-3.pdf");
});

test("the number goes before the extension, so the file still opens", { skip: needsBuild }, () => {
  const { inboxTarget } = load();
  const file = inboxTarget(DIR, "photo.jpg", "jpg", (f) => f === path.join(DIR, "photo.jpg"));
  assert.equal(path.basename(file), "photo-2.jpg");
});

// --- what the agent is told about it ----------------------------------------

test("the prompt carries the caption and the path the file is really at", { skip: needsBuild }, () => {
  const { arrivalPrompt } = load();
  const prompt = arrivalPrompt("summarise this", ["C:\\Users\\me\\.onflip\\inbox\\deal.pdf"]);

  assert.match(prompt, /^summarise this/);
  assert.match(prompt, /deal\.pdf/);
  assert.match(prompt, /already downloaded/);
});

test("a file with no caption still says where it is", { skip: needsBuild }, () => {
  const { arrivalPrompt } = load();
  const prompt = arrivalPrompt("", ["C:\\inbox\\a.txt"]);

  assert.match(prompt, /C:\\inbox\\a\.txt/);
  assert.ok(!prompt.startsWith("\n"));
});
