"use strict";

/**
 * Edit, resend and copy are one row of three, and have to read as one.
 *
 * They did not. Two were text characters — "✎" and "↻" — and the third an
 * SVG icon, which is three different drawing systems in a row of three
 * buttons. A glyph's drawn weight and optical size belong to whichever font
 * the system falls back to, not to the button around it, so no box size
 * makes them agree with each other or with the icon beside them. Reported
 * as buttons that were too small and mismatched, which is what that is.
 *
 * The box sizing had its own quiet disagreement: `.msg-actions button` said
 * 26px and `.copy-btn` said 24px, with the first winning on specificity. It
 * worked, by accident, and read as a mistake to anyone who found it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const TRANSCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "ui", "src", "components", "Transcript.tsx"),
  "utf8"
);
const CSS = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "styles.css"), "utf8");

test("no text glyphs are used as icons in the message actions", () => {
  // The specific characters that were there, and the general rule: these
  // buttons draw icons, not letters.
  const from = TRANSCRIPT.indexOf('className="msg-actions"');
  assert.ok(from > 0, "the actions row has been renamed");
  // Comments stripped first. The rule is about what renders, and the comment
  // explaining this change quotes the very characters it removed - which the
  // first version of this test duly failed on.
  const row = TRANSCRIPT.slice(from, TRANSCRIPT.indexOf("</div>", from)).replace(
    /\{\/\*[\s\S]*?\*\/\}/g,
    ""
  );

  assert.ok(!row.includes("✎"), "the pencil glyph is back");
  assert.ok(!row.includes("↻"), "the reload glyph is back");
  assert.match(row, /<Pencil size=\{14\} \/>/);
  assert.match(row, /<Reload size=\{14\} \/>/);
  assert.match(row, /<CopyButton[^>]*size=\{14\}/);
});

test("all three buttons are sized by one rule", () => {
  // Including the copy button, which brings its own `.copy-btn` size. The
  // selector has to name it, or the two disagree again the moment somebody
  // changes one of them.
  assert.match(CSS, /\.msg-actions button,\s*\n\s*\.msg-actions \.copy-btn \{/);
  const block = CSS.slice(CSS.indexOf(".msg-actions button,"));
  const rule = block.slice(0, block.indexOf("}"));
  assert.match(rule, /width: 28px/);
  assert.match(rule, /height: 28px/);
});

test("and the icon inside each fills the same box", () => {
  // Two icons drawn at their natural size in equal boxes still look
  // unequal; the row reads as one control only when the marks match too.
  assert.match(CSS, /\.msg-actions button svg \{[\s\S]{0,120}width: 14px;[\s\S]{0,120}height: 14px;/);
});

test("the copy button still turns green when it has copied", () => {
  // The new sizing rule sets a colour and has the same specificity as
  // `.copy-btn.copied`, so only source order keeps the tick green. Worth a
  // test precisely because it depends on something that subtle.
  const sizing = CSS.indexOf(".msg-actions button,");
  const copied = CSS.indexOf(".copy-btn.copied");
  assert.ok(copied > sizing, "the copied state must come after the sizing rule to win the tie");
});
