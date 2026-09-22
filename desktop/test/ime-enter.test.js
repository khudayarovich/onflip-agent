"use strict";

/**
 * Enter belongs to the input method while it is composing.
 *
 * Typing Chinese, Japanese or Korean, Enter commits the candidate being
 * chosen, not the line. The composer knew that; the terminal panel ran the
 * half-typed command, a skill's input used the skill, the browser's address
 * bar navigated and the chat search jumped a match — each on the keystroke
 * meant for the IME.
 *
 * The rule is tested for real. The renderer has no harness that can press
 * keys in it, so the other half is a scan: every key handler in the UI that
 * acts on Enter must ask the rule first. A new input written without it
 * fails here rather than in the hands of someone typing Japanese.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ESCAPE = path.join(__dirname, "..", "dist", "shared", "escape.js");
const needsBuild = fs.existsSync(ESCAPE)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const UI = path.join(__dirname, "..", "ui", "src");

test("a key is the IME's while it composes, and only then", { skip: needsBuild }, () => {
  const { composing } = require(ESCAPE);
  assert.equal(composing({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } }), true);
  assert.equal(
    composing({ key: "Process", keyCode: 229, nativeEvent: { isComposing: false } }),
    true,
    "Chromium's 229 marks the key that starts or ends a composition"
  );
  // The false-positive half: an ordinary Enter is still Enter.
  assert.equal(composing({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } }), false);
  assert.equal(composing({ key: "Enter", keyCode: 13 }), false, "an event without a native half");
  assert.equal(composing({}), false);
});

/** Every `.tsx` under ui/src, as [relative path, source]. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push([path.relative(UI, full), fs.readFileSync(full, "utf8")]);
    }
  };
  walk(UI);
  return out;
}

/**
 * The body of the brace-delimited block starting at `open`, skipping
 * comments and string and template literals so a brace — or an apostrophe
 * in "the person's words" — inside one does not count.
 */
function block(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error("unbalanced block");
}

/** Each key handler in a source: JSX `onKeyDown={…}` and `const onKeyDown = (…) => {…}`. */
function keyHandlers(source) {
  const handlers = [];
  for (const m of source.matchAll(/onKeyDown=\{|const onKeyDown = \([^)]*\) => \{/g)) {
    handlers.push(block(source, m.index + m[0].length - 1));
  }
  return handlers;
}

test("every Enter handler in the UI asks the rule first", { skip: needsBuild }, () => {
  let checked = 0;
  for (const [file, source] of sources()) {
    for (const handler of keyHandlers(source)) {
      if (!/key === "Enter"/.test(handler)) continue;
      checked++;
      assert.match(handler, /composing\(e\)/, `${file}: an Enter handler that ignores the input method`);
    }
  }
  // Composer, terminal, skills, address bar, chat search. If this drops, the
  // scan has stopped finding handlers and would pass with none.
  assert.ok(checked >= 5, `found ${checked} Enter handlers`);
});

test("the scan reads a handler as a whole, braces in strings and all", { skip: needsBuild }, () => {
  // The negative half of the scan itself: a handler without the rule is caught,
  // and a brace inside a string does not end the handler early.
  const unguarded =
    'x = <input onKeyDown={(e) => {\n  // the person\'s key }\n  const s = "}";\n  if (e.key === "Enter") go();\n}} />;';
  const [handler] = keyHandlers(unguarded);
  assert.match(handler, /key === "Enter"/);
  assert.doesNotMatch(handler, /composing\(e\)/);
  const named = 'const onKeyDown = (e: React.KeyboardEvent) => {\n  if (composing(e)) return;\n  if (e.key === "Enter") run();\n};';
  assert.match(keyHandlers(named)[0], /composing\(e\)/);
});
