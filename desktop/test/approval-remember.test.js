"use strict";

/**
 * What the "always allow" control says, and what it promises.
 *
 * These were one string and the button carried both: `Always allow "<the
 * command>"`. That read fine while a remembered command was a short prefix
 * like `python`. Since the audit a grant is exact — the key is the entire
 * command — and a heredoc writing a source file turned the button into a
 * wall of code with the word "Always" somewhere near the top. Reported from
 * a screenshot of the real dialog.
 *
 * So the label is the promise, the scope is the thing promised, and the
 * window shows them in different places. This pins the split: a short label
 * with no command in it, and a scope that appears only when it is not
 * already obvious from the command on screen.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ENGINE = path.join(__dirname, "..", "engine", "engine.ts");
const MODAL = path.join(__dirname, "..", "ui", "src", "components", "ApprovalModal.tsx");

test("the label is a promise, never the command", () => {
  // The regression this exists for is one interpolation coming back.
  const source = fs.readFileSync(ENGINE, "utf8");
  const fn = source.slice(source.indexOf("private rememberLabel("));
  const body = fn.slice(0, fn.indexOf("private rememberScope("));

  assert.match(body, /return commandKey\(req\.subject\) \? "Always allow" : undefined/);
  assert.ok(
    !/Always allow "\$\{/.test(body),
    "the command is back inside the label"
  );
});

test("the scope is shown beside the control, not on it", () => {
  const modal = fs.readFileSync(MODAL, "utf8");
  const foot = modal.slice(modal.indexOf('className="modal-foot"'));

  // The button renders the label and nothing else.
  assert.match(foot, /\{request\.rememberLabel\}/);
  assert.ok(!/rememberScope/.test(foot), "the scope is being rendered inside the buttons");
  // And the scope has its own block in the body.
  assert.match(modal.slice(0, modal.indexOf('className="modal-foot"')), /className="remember-scope"/);
});

test("a command that is already on screen is not printed twice", () => {
  // `npm test` keys to `npm test`; a heading and a second copy of it is
  // noise in a dialog that may also be showing a diff.
  const source = fs.readFileSync(ENGINE, "utf8");
  const fn = source.slice(source.indexOf("private rememberScope("));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);

  assert.match(body, /key === \(req\.subject \?\? ""\)\.trim\(\)/);
});

test("the phone says it once, not twice", () => {
  // The bot built its button as `✅ Always allow ${rememberLabel}` while the
  // label itself began "Always allow" — said twice, then truncated at 24
  // characters so the half that mattered was the half that got cut.
  const telegram = fs.readFileSync(path.join(__dirname, "..", "electron", "telegram.ts"), "utf8");

  assert.ok(
    !/`✅ Always allow \$\{oneLine\(ask\.rememberLabel/.test(telegram),
    "the bot is prepending 'Always allow' to a label that already says it"
  );
  assert.match(telegram, /`✅ \$\{oneLine\(ask\.rememberLabel, 40\)\}`/);
});
