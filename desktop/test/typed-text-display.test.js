"use strict";

/**
 * Typed text never reaches the screen from a tool card.
 *
 * `browser_type` types whatever it is handed, and on a login form that is a
 * password. The approval prompt masked it and the log never kept it, but the
 * card showed the arguments verbatim: a collapsed card's subject fell back
 * to the text, an expanded one printed `text: hunter22`, and every replay of
 * the session printed it again. A card cannot tell a password field from a
 * search box, so every typed value is masked there.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist", "engine");
const needsBuild = fs.existsSync(path.join(DIST, "engine.js"))
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-typed-text-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const FENCE = "`".repeat(3);
const TYPED = `${FENCE}onflip\ntool: browser_type\nref: ref_3\ntext: hunter22\n${FENCE}`;
const FORM = `${FENCE}onflip\ntool: browser_type\nfields:\n  - ref: ref_1\n    text: jane@example.test\n  - ref: ref_2\n    text: hunter22\n${FENCE}`;
const DONE = `${FENCE}onflip\ntool: done\nsummary: |\n  finished\n${FENCE}`;

test("a card shows how much was typed, never what", { skip: needsBuild }, () => {
  const { displayArgs } = require(path.join(DIST, "subjects.js"));
  assert.deepEqual(displayArgs("browser_type", { ref: "ref_3", text: "hunter22", submit: true }), {
    ref: "ref_3",
    text: "••••••••",
    submit: true,
  });
  assert.deepEqual(
    displayArgs("browser_type", {
      fields: [
        { ref: "ref_1", text: "jane@example.test" },
        { ref: "ref_2", value: "hunter22" },
      ],
    }),
    { fields: [{ ref: "ref_1", text: "••••••••••••" }, { ref: "ref_2", value: "••••••••" }] }
  );
  assert.equal(displayArgs("browser_type", { fields: '[{"ref":"ref_2","text":"hunter22"}]' }).fields.includes("hunter22"), false);
  assert.equal(displayArgs("Browser-Type", { text: "hunter22" }).text, "••••••••", "however the model spelled it");
});

test("everything else a card shows is untouched", { skip: needsBuild }, () => {
  const { displayArgs } = require(path.join(DIST, "subjects.js"));
  const bash = { command: "npm test", description: "run the tests" };
  assert.equal(displayArgs("bash", bash), bash);
  const write = { path: "notes.txt", content: "text: hunter22 is a sample" };
  assert.equal(displayArgs("write", write), write);
  assert.deepEqual(displayArgs("browser_click", { ref: "ref_4", description: "Sign in" }), {
    ref: "ref_4",
    description: "Sign in",
  });
});

test("a collapsed card's subject never falls back to the typed text", { skip: needsBuild }, () => {
  const { subjectFor } = require(path.join(DIST, "subjects.js"));
  assert.equal(subjectFor("browser_type", { ref: "ref_3", text: "hunter22" }), "ref ref_3");
  assert.equal(subjectFor("browser_type", { text: "hunter22" }), "");
  assert.equal(subjectFor("browser_type", { fields: [{ ref: "ref_1", text: "x" }, { ref: "ref_2", text: "y" }] }), "2 fields");
});

test("a replayed session shows the typing masked", { skip: needsBuild }, () => {
  const { replayItems } = require(path.join(DIST, "replay.js"));
  const items = replayItems([
    { id: "s", role: "system", content: "prompt", createdAt: 1 },
    { id: "u", role: "user", content: "sign me in", createdAt: 2 },
    { id: "a1", role: "assistant", content: TYPED, createdAt: 3 },
    { id: "r1", role: "user", content: '<onflip:result tool="browser_type">Typed into ref_3.</onflip:result>', toolName: "browser_type", createdAt: 4 },
    { id: "a2", role: "assistant", content: FORM, createdAt: 5 },
    { id: "a3", role: "assistant", content: DONE, createdAt: 6 },
  ]);
  const cards = items.filter((i) => i.type === "tool");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].call.args.text, "••••••••");
  assert.ok(!JSON.stringify(items).includes("hunter22"), "nowhere in what the window is sent");
});

test("a live turn's card is masked as it starts", { skip: needsBuild, timeout: 30_000 }, async () => {
  const { Engine } = require(path.join(DIST, "engine.js"));
  const replies = [TYPED, DONE];
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const events = [];
  const engine = new Engine({ emit: (event, data) => events.push({ event, data }), request: async () => ({ allow: true }) }, work);
  engine.transport = { name: "api", send: async () => ({ content: replies.shift() ?? DONE, conversationId: null }), reset() {} };
  engine.connected = true;
  engine.history = [];
  engine.archived = [];
  engine.policy = { mode: "yolo", allowedCommands: new Set(), allowedWriteDirs: new Set(), bashRules: {} };
  engine.context = { instructionSources: [], environment: "", instructions: "", skills: [], cwd: work };
  engine.send("sign me in");
  const deadline = Date.now() + 20_000;
  do await new Promise((r) => setTimeout(r, 50));
  while ((engine.busy || replies.length) && Date.now() < deadline);
  const card = events.find((e) => e.event === "item" && e.data.type === "tool");
  assert.ok(card, "the call reached the window");
  assert.equal(card.data.call.tool, "browser_type");
  assert.equal(card.data.call.subject, "ref ref_3");
  assert.equal(card.data.call.args.text, "••••••••");
  const shown = events.filter((e) => e.event === "item" || e.event === "transcript");
  assert.ok(!JSON.stringify(shown).includes("hunter22"), "no card or transcript the window got carries it");
  void ROOT;
});
