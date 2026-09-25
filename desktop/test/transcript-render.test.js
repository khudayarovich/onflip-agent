"use strict";

/**
 * A tool name the model chose cannot take the window down.
 *
 * The icon and label tables were plain objects indexed by the tool's name,
 * and the name is whatever the model wrote. `constructor` found `Object` in
 * the icon table, React rendered it as a component, and with no error
 * boundary anywhere the whole window went blank — and stayed blank on every
 * reopen, because resuming the session replays the same item.
 *
 * Two fixes, tested separately: the tables are read by own key only, and
 * every transcript item sits in its own error boundary so one that cannot be
 * drawn becomes a line of text instead of an empty window.
 *
 * The renderer is TSX that only Vite ever compiles, so the components are
 * bundled here with the esbuild Vite already brings, and rendered to a
 * string with react-dom/server.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const DESKTOP = path.join(__dirname, "..");
const UI = path.join(DESKTOP, "ui", "src");
const needsBuild = ["esbuild", "react", "react-dom"].every((dep) =>
  fs.existsSync(path.join(DESKTOP, "node_modules", dep, "package.json"))
)
  ? false
  : "desktop dependencies are not installed (run: cd desktop && npm install)";

let bundled = null;
function ui() {
  if (bundled) return bundled;
  const esbuild = require(path.join(DESKTOP, "node_modules", "esbuild"));
  const out = esbuild.buildSync({
    stdin: {
      contents: [
        'import React from "react";',
        'import { renderToStaticMarkup } from "react-dom/server";',
        'import { ToolCard } from "./components/ToolCard";',
        'import { ItemBoundary, TranscriptItem, questionState } from "./components/Transcript";',
        'import { toolLabel } from "./toolNames";',
        "export { React, renderToStaticMarkup, ToolCard, ItemBoundary, TranscriptItem, questionState, toolLabel };",
      ].join("\n"),
      resolveDir: UI,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    nodePaths: [path.join(DESKTOP, "node_modules")],
    loader: { ".svg": "text", ".css": "empty", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const mod = new Module(path.join(UI, "transcript-render.bundle.cjs"));
  mod.filename = mod.id;
  mod.paths = Module._nodeModulePaths(DESKTOP);
  mod._compile(out.outputFiles[0].text, mod.filename);
  bundled = mod.exports;
  return bundled;
}

const PROTOTYPE_NAMES = ["constructor", "__proto__", "valueOf", "toString", "hasOwnProperty", "isPrototypeOf"];

const toolItem = (tool) => ({
  type: "tool",
  id: `id-${tool}`,
  call: { id: `id-${tool}`, tool, subject: "src/app.ts", args: { path: "src/app.ts" } },
});

test("a tool card renders whatever the model named the tool", { skip: needsBuild }, () => {
  const { React, renderToStaticMarkup, ToolCard } = ui();
  for (const tool of PROTOTYPE_NAMES) {
    let html;
    assert.doesNotThrow(() => {
      html = renderToStaticMarkup(React.createElement(ToolCard, { item: toolItem(tool) }));
    }, tool);
    assert.match(html, /tool-card/, tool);
    assert.ok(!/\[object Object\]|native code/.test(html), `${tool}: ${html.slice(0, 200)}`);
  }
});

test("and its label is the name, not something off Object.prototype", { skip: needsBuild }, () => {
  const { toolLabel } = ui();
  assert.equal(toolLabel("constructor", "en"), "Constructor");
  assert.equal(toolLabel("__proto__", "ru").trim(), "Proto");
  // The false-positive half: real names still get their titles.
  assert.equal(toolLabel("read", "en"), "Read File");
  assert.equal(toolLabel("web_search", "uz"), "Veb qidiruv");
  assert.equal(toolLabel("some_new_tool", "en"), "Some New Tool");
});

test("a transcript item with such a name renders too", { skip: needsBuild }, () => {
  const { React, renderToStaticMarkup, TranscriptItem } = ui();
  for (const tool of PROTOTYPE_NAMES) {
    assert.doesNotThrow(
      () => renderToStaticMarkup(React.createElement(TranscriptItem, { item: toolItem(tool) })),
      tool
    );
  }
});

test("an item that cannot be drawn becomes a line of text", { skip: needsBuild }, () => {
  // Error boundaries only act in a live client render, which needs a DOM;
  // their contract is what is checked here. The server renderer would
  // simply rethrow.
  const { React, renderToStaticMarkup, ItemBoundary } = ui();
  const child = React.createElement("div", { className: "fine" }, "an ordinary item");

  const healthy = new ItemBoundary({ children: child });
  assert.equal(renderToStaticMarkup(healthy.render()), '<div class="fine">an ordinary item</div>');

  const broken = new ItemBoundary({ children: child });
  broken.state = ItemBoundary.getDerivedStateFromError(new Error("Objects are not valid as a React child"));
  const html = renderToStaticMarkup(broken.render());
  assert.match(html, /msg-error/);
  assert.match(html, /could not be shown \(Objects are not valid as a React child\)/);
  assert.ok(!html.includes("an ordinary item"));
});

test("a streamed delta does not redraw every item", { skip: needsBuild }, () => {
  // The transcript renders on every delta of the running turn. Items are
  // memoised so the ones that did not change are skipped — which only holds
  // while their props keep their identity: their own progress line rather
  // than the whole map, and a resume callback that is not rebuilt each time.
  const { TranscriptItem } = ui();
  assert.equal(TranscriptItem.$$typeof, Symbol.for("react.memo"), "TranscriptItem is not memoised");
  const fs = require("node:fs");
  const transcript = fs.readFileSync(path.join(UI, "components", "Transcript.tsx"), "utf8");
  assert.match(transcript, /const UserMessage = React\.memo\(function UserMessage\(/);
  // A question's answer is a string and its callback goes to the one
  // question still waiting — every other item gets undefined for both.
  assert.match(
    transcript,
    /<TranscriptItem\s+item=\{entry\.item\}\s+progress=\{toolProgress\[entry\.item\.id\]\}\s+onResume=\{onResume\}\s+answered=\{questions\.answers\.get\(entry\.item\.id\)\}\s+onAnswer=\{entry\.item\.id === questions\.open \? onAnswer : undefined\}\s+\/>/
  );
  const app = fs.readFileSync(path.join(UI, "App.tsx"), "utf8");
  assert.match(app, /onResume=\{busy \|\| engineDown \? undefined : resumeTurn\}/);
  assert.match(app, /const resumeTurn = useCallback\(/);
  assert.match(app, /onAnswer=\{busy \|\| engineDown \? undefined : sendPrompt\}/);
  assert.match(app, /const sendPrompt = useCallback\(/);
});

// ---------------------------------------------------------------------------
// a question, with answers to click
// ---------------------------------------------------------------------------

const question = (over = {}) => ({
  type: "question",
  id: "q1",
  text: "Which part should I build first?",
  choices: [
    { label: "All three now", description: "backend, history and AI together", recommended: true },
    { label: "Only the backend" },
  ],
  ...over,
});
const buttons = (html) => [...html.matchAll(/<button[^>]*class="question-choice[^"]*"[^>]*>/g)].map((m) => m[0]);

test("a waiting question draws its answers as buttons, the recommended one marked", { skip: needsBuild }, () => {
  // Reported: the options were a bulleted list with nothing to click, and
  // the only way to answer was to retype one.
  const { React, renderToStaticMarkup, TranscriptItem } = ui();
  const html = renderToStaticMarkup(React.createElement(TranscriptItem, { item: question(), onAnswer: () => true }));
  const found = buttons(html);
  assert.equal(found.length, 2);
  assert.match(found[0], /class="question-choice recommended"/);
  assert.doesNotMatch(found[1], /recommended/);
  assert.ok(found.every((b) => !/disabled/.test(b)), "clickable while it waits");
  assert.match(html, /All three now<span class="question-choice-badge">Recommended<\/span>/);
  assert.match(html, /<span class="question-choice-desc">backend, history and AI together<\/span>/);
  // An answer of one's own, beside the offered ones.
  assert.match(html, /class="question-other"/);
  assert.match(html, /placeholder="Something else\? Type your own answer"/);
  // The question is shown once — not again as a list under the buttons.
  assert.equal(html.split("Only the backend").length - 1, 1);
});

test("an answered question shows what was picked and takes no more", { skip: needsBuild }, () => {
  const { React, renderToStaticMarkup, TranscriptItem } = ui();
  const html = renderToStaticMarkup(React.createElement(TranscriptItem, { item: question(), answered: "only the backend" }));
  const found = buttons(html);
  assert.ok(found.every((b) => /disabled/.test(b)), "nothing more to click");
  assert.match(found[1], /class="question-choice picked"/);
  assert.match(found[1], /aria-pressed="true"/);
  assert.doesNotMatch(html, /question-other/);
});

test("a question with no answers offered still takes one, and an old one reads as before", { skip: needsBuild }, () => {
  const { React, renderToStaticMarkup, TranscriptItem } = ui();
  const bare = question({ choices: undefined, text: "Which port should the server use?" });
  const waiting = renderToStaticMarkup(React.createElement(TranscriptItem, { item: bare, onAnswer: () => true }));
  assert.doesNotMatch(waiting, /question-choices/);
  assert.match(waiting, /placeholder="Type your answer"/);
  // Not the waiting one (or a turn is running): the question, and nothing to type into.
  const past = renderToStaticMarkup(React.createElement(TranscriptItem, { item: bare }));
  assert.match(past, /Which port should the server use\?/);
  assert.doesNotMatch(past, /question-other|question-choices/);
});

test("the question waiting is the last thing said, and a reply answers the one before it", { skip: needsBuild }, () => {
  const { questionState } = ui();
  const q = (id) => ({ type: "question", id, text: id });
  const user = (id, text) => ({ type: "user", id, text });
  const quiet = [{ type: "notice", id: "n", text: "retrying" }, { type: "duration", id: "d", ms: 5000 }];

  let state = questionState([user("u1", "build it"), q("q1"), ...quiet]);
  assert.equal(state.open, "q1", "notices and the turn's time do not move the conversation on");

  state = questionState([user("u1", "build it"), q("q1"), user("u2", "Only the backend")]);
  assert.equal(state.open, null);
  assert.equal(state.answers.get("q1"), "Only the backend");

  // Something ran after it — a resume nobody typed — so it was never answered.
  const tool = { type: "tool", id: "t1", call: { id: "t1", tool: "read", subject: "a", args: {} } };
  state = questionState([q("q1"), tool, user("u2", "and now this")]);
  assert.equal(state.open, null);
  assert.equal(state.answers.has("q1"), false);
});
