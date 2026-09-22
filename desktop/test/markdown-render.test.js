"use strict";

/**
 * The chat's Markdown, as a coding conversation writes it.
 *
 * - Underscores emphasised inside words: `my_var_name` came out as
 *   my<em>var</em>name, `C:\Users\john_doe\my_project` lost its
 *   underscores to italics, and `__init__` became a bold "init".
 * - Numbered steps separated by a blank line or a code block each started
 *   again at 1, and a list written from 3 was shown from 1.
 * - A link to Wikipedia's `Foo_(bar)` ended at "(bar".
 *
 * The renderer is bundled with the esbuild Vite already brings and rendered
 * with react-dom/server.
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
function md(text) {
  if (!bundled) {
    const esbuild = require(path.join(DESKTOP, "node_modules", "esbuild"));
    const out = esbuild.buildSync({
      stdin: {
        contents: [
          'import React from "react";',
          'import { renderToStaticMarkup } from "react-dom/server";',
          'import { Markdown } from "./markdown";',
          "export const render = (text) => renderToStaticMarkup(React.createElement(Markdown, { text }));",
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
    const mod = new Module(path.join(UI, "markdown-render.bundle.cjs"));
    mod.filename = mod.id;
    mod.paths = Module._nodeModulePaths(DESKTOP);
    mod._compile(out.outputFiles[0].text, mod.filename);
    bundled = mod.exports;
  }
  return bundled.render(text);
}

test("an underscore inside a word is part of the word", { skip: needsBuild }, () => {
  const names = md("Rename my_var_name and edit test_utils_helper.py");
  assert.doesNotMatch(names, /<em>/);
  assert.match(names, /my_var_name/);
  const path_ = md("Open C:\\Users\\john_doe\\my_project\\notes.txt");
  assert.match(path_, /john_doe\\my_project/);
  const dunder = md("Override the __init__ method and __repr__ too");
  assert.doesNotMatch(dunder, /<strong>/);
  assert.match(dunder, /__init__/);
});

test("emphasis a writer meant still is", { skip: needsBuild }, () => {
  // The false-positive half.
  assert.match(md("say _this_ now"), /<em>this<\/em>/);
  assert.match(md("*quietly* and **loudly**"), /<em>quietly<\/em> and <strong>loudly<\/strong>/);
});

test("numbered steps keep their numbers across blank lines and code", { skip: needsBuild }, () => {
  const loose = md("1. First step\n\n2. Second step\n\n3. Third step");
  assert.match(loose, /<ol><li>First step<\/li><\/ol>/);
  assert.match(loose, /<ol start="2"><li>Second step<\/li><\/ol>/);
  assert.match(loose, /<ol start="3"><li>Third step<\/li><\/ol>/);
  const withCode = md("1. Install:\n\n```\nnpm i\n```\n\n2. Build:");
  assert.match(withCode, /<ol start="2"><li>Build:<\/li><\/ol>/);
  assert.match(md("3. third\n4. fourth"), /<ol start="3"><li>third<\/li><li>fourth<\/li><\/ol>/);
});

test("a link keeps the parentheses in its address", { skip: needsBuild }, () => {
  assert.match(
    md("See https://en.wikipedia.org/wiki/Foo_(bar) for more."),
    /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/
  );
  assert.match(
    md("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) for more."),
    /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"[^>]*>Foo<\/a> for more\./
  );
  // A sentence's full stop is still the sentence's, and no other scheme
  // ever becomes a link.
  assert.match(md("see https://x.y/docs."), /href="https:\/\/x\.y\/docs"[^>]*>https:\/\/x\.y\/docs<\/a>\./);
  assert.doesNotMatch(md("[click](javascript:alert(1))"), /href="javascript/);
});

test("an attachment chip shows the file name on Windows too", { skip: needsBuild }, () => {
  // Split on "/" alone, a Windows path came back whole: the chip showed
  // "C:\Users\…\Desk…" instead of the file.
  const esbuild = require(path.join(DESKTOP, "node_modules", "esbuild"));
  const out = esbuild.buildSync({
    stdin: { contents: 'export { fileName } from "./components/Composer";', resolveDir: UI, loader: "tsx" },
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
  const mod = new Module(path.join(UI, "composer-name.bundle.cjs"));
  mod.filename = mod.id;
  mod.paths = Module._nodeModulePaths(DESKTOP);
  mod._compile(out.outputFiles[0].text, mod.filename);
  const { fileName } = mod.exports;
  assert.equal(fileName("C:\\Users\\me\\Desktop\\shot.png"), "shot.png");
  assert.equal(fileName("/home/me/shot.png"), "shot.png");
  assert.equal(fileName("shot.png"), "shot.png");
});
