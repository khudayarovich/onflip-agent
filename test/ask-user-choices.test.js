"use strict";

/**
 * A question the agent asks is a decision to make, not text to retype.
 *
 * Reported from a Free account: the turn ended on "OnFlip needs your
 * decision — Please enable the on-machine file tools for this session, then I
 * can continue directly." Two things were wrong with it. The question was a
 * refusal (the tools are attached to every turn), and no detector saw it,
 * because nothing in it is negated. And even a real question arrived as a
 * paragraph: the options the model offered were a bulleted list with nothing
 * to click, and an option written "Yes: build all three" reached the window
 * as a `yes` field.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-ask-user-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";
const { parseChoices, MAX_CHOICES } = require("../dist/agent/choices");
const { parseTurn } = require("../dist/agent/protocol");
const { runTurn, stringList } = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");

const LIVE =
  "I can build the Python backend + persistent game history + AI opponent, but I need to modify/create several project files. Please enable the on-machine file tools for this session, then I can continue directly.";

const said = (role, content) => ({ id: `${role}-${Math.random()}`, role, content });
const askBlock = (question, options) =>
  ["````onflip", "tool: ask_user", "question: |", `  ${question}`, "options:", ...options.map((o) => `  - ${o}`), "````"].join("\n");

// ---------------------------------------------------------------------------
// reading the options
// ---------------------------------------------------------------------------

test("an option is a label, a description after a dash, and a recommendation", () => {
  assert.deepEqual(
    parseChoices([
      "SQLite (Recommended) — one file, no server",
      "PostgreSQL – a server, better concurrency",
      "Keep the JSON file - nothing to install",
    ]),
    [
      { label: "SQLite", description: "one file, no server", recommended: true },
      { label: "PostgreSQL", description: "a server, better concurrency" },
      { label: "Keep the JSON file", description: "nothing to install" },
    ]
  );
});

test("the recommendation is found wherever the model put it, in the user's language", () => {
  const recommended = (option) => parseChoices([option])[0];
  assert.deepEqual(recommended("[recommended] Build all three now"), { label: "Build all three now", recommended: true });
  assert.deepEqual(recommended("Recommended: build the backend first"), { label: "build the backend first", recommended: true });
  assert.deepEqual(recommended("⭐ Build all three"), { label: "Build all three", recommended: true });
  assert.deepEqual(recommended("SQLite — recommended: one file"), { label: "SQLite", description: "one file", recommended: true });
  assert.deepEqual(recommended("Сначала бэкенд (рекомендуется) — история и ИИ потом"), {
    label: "Сначала бэкенд",
    description: "история и ИИ потом",
    recommended: true,
  });
  assert.deepEqual(recommended("Avval backend (tavsiya etiladi)"), { label: "Avval backend", recommended: true });
});

test("a label that only starts with the word is not a recommendation", () => {
  // The false-positive half: the marker is a marker, not a word anywhere.
  assert.deepEqual(parseChoices(["Recommended settings only"]), [{ label: "Recommended settings only" }]);
  assert.deepEqual(parseChoices(["Use the recommended defaults — fastest"]), [
    { label: "Use the recommended defaults", description: "fastest" },
  ]);
});

test("one recommendation, and a colon or a hyphenated word does not split a label", () => {
  const choices = parseChoices(["A (Recommended)", "B (recommended)", "Start at 10:30", "Keep the -v flag", "Yes: build all three"]);
  assert.deepEqual(choices.map((c) => Boolean(c.recommended)), [true, false, false, false, false]);
  assert.deepEqual(choices.map((c) => c.label), ["A", "B", "Start at 10:30", "Keep the -v flag", "Yes: build all three"]);
});

test("labels are plain text, unique, and there are only so many", () => {
  assert.deepEqual(parseChoices(["**SQLite** — `one` file"]), [{ label: "SQLite", description: "one file" }]);
  // Two labels alike would send the model an answer it cannot place.
  assert.deepEqual(parseChoices(["Yes — all three", "Yes — only the backend"]), [
    { label: "Yes — all three" },
    { label: "Yes — only the backend" },
  ]);
  assert.deepEqual(parseChoices(["", "   ", "— dangling"]), [{ label: "— dangling" }]);
  assert.equal(parseChoices(Array.from({ length: 20 }, (_, i) => `option ${i}`)).length, MAX_CHOICES);
});

test("an option the model wrote as an object is put into the one-line form", () => {
  assert.deepEqual(
    stringList([
      { label: "SQLite", description: "one file", recommended: true },
      { text: "PostgreSQL" },
      "Keep JSON",
      { unrelated: 1 },
    ]),
    ["SQLite (Recommended) — one file", "PostgreSQL", "Keep JSON", '{\n  "unrelated": 1\n}']
  );
});

// ---------------------------------------------------------------------------
// the block parser
// ---------------------------------------------------------------------------

test("an option with a colon in it stays an option", () => {
  const { calls } = parseTurn(askBlock("Which part first?", ["Yes: build all three now", "Only the backend — AI later"]));
  assert.deepEqual(calls[0].arguments.options, ["Yes: build all three now", "Only the backend — AI later"]);
});

test("an option that wraps onto a second line is one option", () => {
  const reply = [
    "````onflip",
    "tool: ask_user",
    "question: |",
    "  Which part first?",
    "options:",
    "  - Build all three now (Recommended) — the backend, the history",
    "    and the AI opponent",
    "  - Only the backend",
    "````",
  ].join("\n");
  assert.deepEqual(parseTurn(reply).calls[0].arguments.options, [
    "Build all three now (Recommended) — the backend, the history and the AI opponent",
    "Only the backend",
  ]);
});

test("every other list is still read as fields", () => {
  // The false-positive half: todo_write's `- content: …` items must stay
  // objects, or the task list arrives as strings and is refused.
  const reply = [
    "```onflip",
    "tool: todo_write",
    "todos:",
    "  - content: write the backend",
    "    status: in_progress",
    "```",
  ].join("\n");
  assert.deepEqual(parseTurn(reply).calls[0].arguments.todos, [{ content: "write the backend", status: "in_progress" }]);
});

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

function workspace() {
  const dir = fs.mkdtempSync(path.join(HOME, "ws-"));
  fs.writeFileSync(path.join(dir, "app.py"), "print('chess')\n");
  const session = createSessionState();
  const tools = createToolRegistry({
    cwd: dir,
    session,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });
  return { session, tools };
}

async function turn(replies) {
  const { session, tools } = workspace();
  const sent = [];
  const finals = [];
  const notices = [];
  const history = [said("system", "prompt"), said("user", "add a backend, a game history and an AI opponent")];
  const transport = {
    name: "api",
    async send(h) {
      sent.push(h[h.length - 1].content);
      return { conversationId: null, content: replies.shift() };
    },
    reset() {},
  };
  const result = await runTurn(history, {
    transport,
    tools,
    session,
    model: "m",
    maxIterations: 8,
    shellEnabled: true,
    signal: new AbortController().signal,
    events: {
      onFinal: (text, meta) => finals.push({ text, meta }),
      onNotice: (text) => notices.push(text),
    },
  });
  return { result, sent, finals, notices };
}

test("the live question is sent back, and the turn carries on", async () => {
  const { finals, notices, sent } = await turn([
    askBlock(LIVE, []).replace("options:\n", ""),
    "```onflip\ntool: read\npath: app.py\n```",
    "````onflip\ntool: done\nsummary: |\n  Read app.py.\n````",
  ]);
  assert.equal(finals.length, 1, "the refusal must not reach the user as a question");
  assert.equal(finals[0].meta.kind, "done");
  assert.ok(notices.some((n) => /could not use its tools/.test(n)), notices.join(" | "));
  // What the model is told names the block it tried to end on.
  assert.match(sent[1], /ended the turn with an `ask_user` block, but what it asked is not a question the user can answer/);
});

test("a real question ends the turn, with its options apart from its text", async () => {
  const { finals } = await turn([
    askBlock("Which part should I build first?", [
      "All three now (Recommended) — backend, history and AI together",
      "Only the backend",
    ]),
  ]);
  assert.equal(finals.length, 1);
  const { text, meta } = finals[0];
  assert.equal(meta.kind, "ask_user");
  assert.deepEqual(meta.options, ["All three now (Recommended) — backend, history and AI together", "Only the backend"]);
  // A window that draws the options as buttons gets the question alone…
  assert.equal(meta.question, "Which part should I build first?");
  // …and a reader with nothing to click still gets the list.
  assert.match(text, /^Which part should I build first\?\n- All three now \(Recommended\)/);
});
