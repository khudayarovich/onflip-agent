"use strict";

/**
 * A name from outside is looked up among OnFlip's own keys only.
 *
 * Lookup tables here are plain objects, and a plain object answers for
 * every key on Object.prototype as well as its own. The names come from the
 * model (tool names), from the user (model slugs) or from settings, so
 * `constructor` found the Object function: the tool registry reported
 * "function Object() { [native code] }" as a tool's canonical name, and a
 * model named "constructor" was normalised to that function.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-proto-"));
process.env.ONFLIP_PROVIDER = "chatgpt";
const { createToolRegistry, createSessionState } = require("../dist/tools");
const { normalizeModel } = require("../dist/models");
const { labelFor } = require("../dist/providers/qwen/browser");

const NAMES = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];

const registry = () =>
  createToolRegistry({
    cwd: process.env.ONFLIP_CONFIG_DIR,
    session: createSessionState(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });

test("a tool named after Object.prototype is an unknown tool, by its own name", async () => {
  const tools = registry();
  for (const name of NAMES) {
    assert.equal(tools.canonical(name), name.toLowerCase(), name);
    assert.equal(tools.get(name), undefined, name);
    const result = await tools.run(name, {});
    assert.equal(result.error, true, name);
    assert.match(result.output, new RegExp(`Unknown tool: "${name}"`));
  }
  // The false-positive half: aliases still fold onto real tools.
  assert.equal(tools.canonical("Read-File"), "read");
  assert.equal(tools.canonical("finish"), "done");
});

test("a model slug named after Object.prototype passes through as text", () => {
  for (const name of NAMES) {
    assert.equal(normalizeModel(name), name.toLowerCase(), name);
  }
  assert.equal(normalizeModel("gpt5"), "gpt-5");
  assert.equal(normalizeModel("deepseek-instant"), "deepseek-chat");
});

test("a Qwen mode named after Object.prototype has no label", () => {
  for (const name of NAMES) assert.equal(labelFor(name), "", name);
  assert.equal(labelFor("qwen3-max"), "Qwen3.8-Max");
});
