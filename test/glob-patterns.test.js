"use strict";

/**
 * A pattern written the way models write it finds the files.
 *
 * Paths are matched relative to the search root, so `./src/**\/*.ts` — the
 * most common spelling — and an absolute pattern into the project both
 * matched nothing, for `glob` and for `grep`'s `include` alike. "No files
 * match" then sent the model off to conclude the files did not exist.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { globTool, grepTool, rootedPattern } = require("../dist/tools/fs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-glob-"));
fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
fs.writeFileSync(path.join(dir, "src", "lib", "b.ts"), "export const b = 2;\n");
fs.writeFileSync(path.join(dir, "README.md"), "# readme\n");

const ctx = {
  cwd: dir,
  session: { readFiles: new Map(), snapshots: [] },
  requestPermission: async () => ({ allow: true }),
  signal: new AbortController().signal,
};
const files = (output) => output.split("\n").sort();
const slash = (p) => p.replace(/\\/g, "/");

test("glob: a leading ./ is the same pattern", async () => {
  const plain = await globTool.run({ pattern: "src/**/*.ts" }, ctx);
  const dotted = await globTool.run({ pattern: "./src/**/*.ts" }, ctx);
  assert.deepEqual(files(slash(dotted.output)), ["src/a.ts", "src/lib/b.ts"]);
  assert.equal(dotted.output, plain.output);
});

test("glob: an absolute pattern into the project is read from the root", async () => {
  const r = await globTool.run({ pattern: `${slash(dir)}/src/**/*.ts` }, ctx);
  assert.deepEqual(files(slash(r.output)), ["src/a.ts", "src/lib/b.ts"]);
});

test("glob: one pointing elsewhere says how to ask for it", async () => {
  const elsewhere = slash(path.join(os.tmpdir(), "somewhere-else"));
  const r = await globTool.run({ pattern: `${elsewhere}/**/*.ts` }, ctx);
  assert.equal(r.error, true);
  assert.match(r.output, /outside the search root[\s\S]*`path`/);
});

test("grep: include takes the same spellings", async () => {
  const dotted = await grepTool.run({ pattern: "export", include: "./src/*.ts" }, ctx);
  assert.match(slash(dotted.output), /src\/a\.ts:1/);
  assert.doesNotMatch(dotted.output, /b\.ts/);
  const backslashed = await grepTool.run({ pattern: "export", include: ".\\src\\lib\\*.ts" }, ctx);
  assert.match(slash(backslashed.output), /src\/lib\/b\.ts:1/);
});

test("the patterns that always worked still do", async () => {
  // The false-positive half.
  assert.deepEqual(rootedPattern("**/*.ts", dir), { pattern: "**/*.ts" });
  assert.deepEqual(rootedPattern("././src/x.ts", dir), { pattern: "src/x.ts" });
  const none = await globTool.run({ pattern: "*.py" }, ctx);
  assert.match(none.output, /No files match/);
  const md = await globTool.run({ pattern: "*.md" }, ctx);
  assert.equal(md.output, "README.md");
});
