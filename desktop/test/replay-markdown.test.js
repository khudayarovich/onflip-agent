"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "engine", "replay.js");
const needsBuild = fs.existsSync(DIST) ? false : "desktop/dist is not built";

test("replay repairs a terminal answer split by nested code fences", { skip: needsBuild }, () => {
  const { replayItems } = require(DIST);
  const raw = [
    "Report follows.",
    "```onflip",
    "tool: done",
    "summary: |",
    "  **Error**",
    "```",
    "the logged output",
    "```text",
    "Explanation after the output.",
    "```",
  ].join("\n");
  const items = replayItems([{ id: "a", role: "assistant", content: raw }]);

  assert.equal(items.length, 1);
  assert.equal(items[0].type, "assistant");
  assert.equal(
    items[0].text,
    "Report follows.\n\n**Error**\n```\nthe logged output\n```\nExplanation after the output."
  );
  assert.doesNotMatch(items[0].text, /tool:\s*done|```onflip/);
});
