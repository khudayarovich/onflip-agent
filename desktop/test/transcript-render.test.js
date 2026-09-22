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
        'import { ItemBoundary, TranscriptItem } from "./components/Transcript";',
        'import { toolLabel } from "./toolNames";',
        "export { React, renderToStaticMarkup, ToolCard, ItemBoundary, TranscriptItem, toolLabel };",
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
  assert.match(transcript, /<TranscriptItem item=\{entry\.item\} progress=\{toolProgress\[entry\.item\.id\]\} onResume=\{onResume\} \/>/);
  const app = fs.readFileSync(path.join(UI, "App.tsx"), "utf8");
  assert.match(app, /onResume=\{busy \|\| engineDown \? undefined : resumeTurn\}/);
  assert.match(app, /const resumeTurn = useCallback\(/);
});
