"use strict";

/**
 * The approval for a write to an instruction file, as the window shows it.
 *
 * The rule itself is tested with the engine package; what is tested here is
 * the prompt a person sees. It asks in auto-edit, says why, and does not
 * offer "Always allow writes in this folder" — a remembered folder does not
 * clear an instruction file, so the button would promise something the next
 * write breaks.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist", "engine", "engine.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-instruction-approval-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

function makeEngine() {
  const { Engine } = require(DIST);
  const { createPolicy } = require(path.join(ROOT, "dist", "agent", "permissions.js"));
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const asked = [];
  const peer = {
    emit() {},
    async request(method, dto) {
      asked.push({ method, dto });
      return { allow: true };
    },
  };
  const engine = new Engine(peer, work);
  engine.policy = createPolicy(work, "auto-edit");
  return { engine, work, asked };
}

const write = (work, rel) => ({ kind: "write", tool: "edit", subject: rel, targetPath: path.join(work, rel) });

test("an instruction file asks in auto-edit, says why, and offers no 'always'", { skip: needsBuild }, async () => {
  const { engine, work, asked } = makeEngine();
  const decision = await engine.requestPermission(write(work, "AGENTS.md"));
  assert.equal(decision.allow, true, "the person said yes");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].method, "approval");
  assert.match(asked[0].dto.reason, /instruction file — later sessions read it as instructions/);
  assert.equal(asked[0].dto.rememberLabel, undefined, "no button that the next write would break");
});

test("while an ordinary edit still goes through unasked", { skip: needsBuild }, async () => {
  const { engine, work, asked } = makeEngine();
  const decision = await engine.requestPermission(write(work, path.join("src", "app.ts")));
  assert.equal(decision.allow, true);
  assert.deepEqual(asked, [], "auto-edit means what it says");
  assert.equal(engine.rememberLabel(write(work, path.join("src", "app.ts"))), "Always allow writes in src");
});
