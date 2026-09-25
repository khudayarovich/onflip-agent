"use strict";

/**
 * A question's answers reach the window and the phone as choices to click.
 *
 * Reported: "OnFlip needs your decision" arrived as a paragraph, its options a
 * bulleted list inside the text with nothing to click. The engine now reads
 * the options into choices — label, what it means, which one the agent
 * recommends — and sends the question without the list, so it is not shown
 * twice. A reopened session rebuilds the same choices from the stored reply,
 * and Telegram's buttons send back exactly what the window's do.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-question-choices-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const ROOT = path.join(__dirname, "..", "..");
const ENGINE = path.join(__dirname, "..", "dist", "engine", "engine.js");
const REPLAY = path.join(__dirname, "..", "dist", "engine", "replay.js");
const TELEGRAM = path.join(__dirname, "..", "dist", "shared", "telegram-format.js");
const needsBuild = [ENGINE, REPLAY, TELEGRAM].every((f) => fs.existsSync(f)) ? false : "desktop/dist is not built";

/** The built engine, a window that records what it is sent, and scripted replies. */
function engineWith(replies) {
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  providers.closeBrowser = async () => {};
  const { Engine } = require(ENGINE);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  fs.writeFileSync(path.join(work, "app.py"), "print('chess')\n");
  const events = [];
  const engine = new Engine({ emit: (event, data) => events.push({ event, data }), request: async () => ({ allow: true }) }, work);
  engine.transport = {
    name: "api",
    async send() {
      return { content: replies.shift() ?? "````onflip\ntool: done\nsummary: |\n  done\n````", conversationId: null };
    },
    reset() {},
  };
  engine.connected = true;
  engine.history = [];
  engine.archived = [];
  engine.policy = { mode: "yolo", allowedCommands: new Set(), allowedWriteDirs: new Set(), bashRules: {} };
  engine.context = { instructionSources: [], environment: "", instructions: "", skills: [], cwd: work };
  return { engine, items: () => events.filter((e) => e.event === "item").map((e) => e.data) };
}

async function idle(engine) {
  do await new Promise((r) => setTimeout(r, 50));
  while (engine.busy);
}

const asked = [
  "Two ways to go.",
  "",
  "````onflip",
  "tool: ask_user",
  "question: |",
  "  Which part should I build first?",
  "options:",
  "  - All three now (Recommended) — backend, history and AI together",
  "  - Yes: only the backend",
  "````",
].join("\n");

test("the window is sent the question alone, with its choices beside it", { skip: needsBuild }, async () => {
  const { engine, items } = engineWith([asked]);
  engine.send("add a backend, history and an AI opponent");
  await idle(engine);
  const question = items().find((i) => i.type === "question");
  assert.ok(question, JSON.stringify(items()));
  assert.equal(question.text, "Two ways to go.\n\nWhich part should I build first?");
  assert.deepEqual(question.choices, [
    { label: "All three now", description: "backend, history and AI together", recommended: true },
    { label: "Yes: only the backend" },
  ]);
});

test("the reported question never reaches the window as one", { skip: needsBuild }, async () => {
  // "Please enable the on-machine file tools for this session" — asked of
  // the user, who has nothing to enable. It goes back to the model, and the
  // turn carries on.
  const { engine, items } = engineWith([
    "````onflip\ntool: ask_user\nquestion: |\n  I can build the Python backend + persistent game history + AI opponent, but I need to modify/create several project files. Please enable the on-machine file tools for this session, then I can continue directly.\n````",
    "```onflip\ntool: read\npath: app.py\n```",
    "````onflip\ntool: done\nsummary: |\n  Read app.py.\n````",
  ]);
  engine.send("add a backend, history and an AI opponent");
  await idle(engine);
  const all = items();
  assert.equal(all.some((i) => i.type === "question"), false, JSON.stringify(all));
  assert.ok(all.some((i) => i.type === "notice" && /could not use its tools/.test(i.text)));
  assert.ok(all.some((i) => i.type === "tool" && i.call.tool === "read"));
  assert.ok(all.some((i) => i.type === "assistant" && /Read app\.py\./.test(i.text)));
});

test("a reopened session draws the question with the same choices", { skip: needsBuild }, () => {
  const { replayItems } = require(REPLAY);
  const items = replayItems([
    { id: "u1", role: "user", content: "add a backend, history and an AI opponent" },
    { id: "a1", role: "assistant", content: asked },
  ]);
  const question = items.find((i) => i.type === "question");
  assert.ok(question, JSON.stringify(items));
  assert.equal(question.text, "Two ways to go.\n\nWhich part should I build first?");
  assert.deepEqual(question.choices, [
    { label: "All three now", description: "backend, history and AI together", recommended: true },
    { label: "Yes: only the backend" },
  ]);
});

test("a question that offered nothing has no choices, and its text is untouched", { skip: needsBuild }, () => {
  const { replayItems } = require(REPLAY);
  const [question] = replayItems([
    { id: "a1", role: "assistant", content: "````onflip\ntool: ask_user\nquestion: |\n  Which port?\n````" },
  ]);
  assert.equal(question.type, "question");
  assert.equal(question.text, "Which port?");
  assert.equal(question.choices, undefined);
});

test("Telegram's buttons are the window's choices, and send back the same answer", { skip: needsBuild }, () => {
  const { replyMessages } = require(TELEGRAM);
  const { parts, buttons } = replyMessages("Which part should I build first?", [
    { label: "All three now", description: "backend, history and AI together", recommended: true },
    { label: "Only the backend" },
  ]);
  assert.deepEqual(buttons, [
    { text: "⭐ All three now", answer: "All three now" },
    { text: "Only the backend", answer: "Only the backend" },
  ]);
  // A button holds a label only, so the meanings go under the question.
  const html = parts.join("\n");
  assert.match(html, /Which part should I build first\?/);
  assert.match(html, /⭐ <b>All three now<\/b> — backend, history and AI together/);
  // An ordinary answer is exactly what it was before.
  const plain = replyMessages("Done — the build passes.");
  assert.deepEqual(plain.buttons, []);
  assert.equal(plain.parts.join(""), "Done — the build passes.");
});
