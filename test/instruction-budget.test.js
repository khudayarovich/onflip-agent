"use strict";

/**
 * Instruction files share one budget, and a copy is sent once.
 *
 * The 32 KB cap was per file, and a folder may hold eight instruction files,
 * plus every folder above it and the global one. OnFlip's own prompt is about
 * 22,000 characters; four files at the per-file cap made a first send of
 * about 150,000, past the 112,586 the composer is known to refuse — every
 * send in that folder would have failed. And CLAUDE.md, very often a copy of
 * AGENTS.md, was sent a second time on every turn.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-instructions-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
fs.mkdirSync(process.env.ONFLIP_CONFIG_DIR, { recursive: true });

const { loadProjectContext, MAX_INSTRUCTION_TOTAL_BYTES } = require("../dist/agent/context");

/** A repository with a package folder in it; returns the package folder. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(HOME, "repo-"));
  fs.mkdirSync(path.join(root, ".git"));
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(pkg);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return pkg;
}

const kb = (n, fill) => `${fill}\n`.repeat(Math.ceil((n * 1000) / (fill.length + 1)));

test("a file identical to one already in is sent once", () => {
  const rules = "# Rules\n\nUse two-space indentation.";
  const pkg = repo({ "pkg/AGENTS.md": rules, "pkg/CLAUDE.md": rules });
  const ctx = loadProjectContext(pkg);
  assert.equal(ctx.instructions.split("Use two-space indentation.").length - 1, 1);
  assert.equal(ctx.instructionSources.length, 1);
  assert.deepEqual(ctx.instructionsSkipped, []);
});

test("together the files stay under one budget, nearest folder first", () => {
  const pkg = repo({
    "AGENTS.md": kb(20, "root-level guidance"),
    "pkg/AGENTS.md": kb(20, "package guidance"),
  });
  const ctx = loadProjectContext(pkg);
  assert.ok(Buffer.byteLength(ctx.instructions) <= MAX_INSTRUCTION_TOTAL_BYTES + 200, "headers aside, within the total");
  assert.match(ctx.instructions, /package guidance/, "the folder being worked in is kept");
  assert.doesNotMatch(ctx.instructions, /root-level guidance/);
  assert.deepEqual(
    ctx.instructionsSkipped.map((s) => [path.relative(path.dirname(pkg), s.file), s.reason]),
    [["AGENTS.md", "total"]],
    "and the one left out is named, with why"
  );
});

test("the global file is the first to give way", () => {
  fs.writeFileSync(path.join(process.env.ONFLIP_CONFIG_DIR, "AGENTS.md"), kb(15, "global preference"));
  try {
    const pkg = repo({ "pkg/AGENTS.md": kb(20, "package guidance") });
    const ctx = loadProjectContext(pkg);
    assert.match(ctx.instructions, /package guidance/);
    assert.doesNotMatch(ctx.instructions, /global preference/);
    assert.equal(ctx.instructionsSkipped[0].reason, "total");
  } finally {
    fs.rmSync(path.join(process.env.ONFLIP_CONFIG_DIR, "AGENTS.md"));
  }
});

test("small files all arrive, in their usual order, and one too big alone says so", () => {
  // The false-positive half.
  fs.writeFileSync(path.join(process.env.ONFLIP_CONFIG_DIR, "AGENTS.md"), "global: answer briefly");
  try {
    const pkg = repo({
      "AGENTS.md": "root: run the linter",
      "pkg/AGENTS.md": "package: tests live in test/",
      "pkg/.onflip/memory.md": "memory: the build uses tsc",
      "pkg/CLAUDE.md": kb(40, "far too long"),
    });
    const ctx = loadProjectContext(pkg);
    const at = (s) => ctx.instructions.indexOf(s);
    for (const s of ["global:", "root:", "package:", "memory:"]) assert.ok(at(s) >= 0, `${s} is in`);
    assert.ok(at("global:") < at("root:") && at("root:") < at("package:") && at("package:") < at("memory:"));
    assert.deepEqual(ctx.instructionsSkipped.map((s) => [path.basename(s.file), s.reason]), [["CLAUDE.md", "file"]]);
  } finally {
    fs.rmSync(path.join(process.env.ONFLIP_CONFIG_DIR, "AGENTS.md"));
  }
});
