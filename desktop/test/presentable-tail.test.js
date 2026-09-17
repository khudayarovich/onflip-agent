"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "engine", "presentable.js");
const needsBuild = fs.existsSync(DIST) ? false : "desktop/dist is not built";

test("a closing block streams its nested Markdown fences as content", { skip: needsBuild }, () => {
  const { presentableTail } = require(DIST);
  const full = [
    "````onflip",
    "tool: done",
    "summary: |",
    "  **Result**",
    "  ```text",
    "  first line",
    "  second line",
    "  ```",
    "  Explanation after the code.",
    "````",
  ].join("\n");

  assert.equal(
    presentableTail(full),
    "**Result**\n```text\nfirst line\nsecond line\n```\nExplanation after the code."
  );
});

test("an ordinary tool call remains a compact streaming label", { skip: needsBuild }, () => {
  const { presentableTail } = require(DIST);
  assert.equal(
    presentableTail("```onflip\ntool: read\npath: package.json\n```"),
    "▸ read call"
  );
});
