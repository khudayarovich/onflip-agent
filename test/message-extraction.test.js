"use strict";

/**
 * Reading a reply back off the page, pinned.
 *
 * ChatGPT hands us rendered HTML and we turn it back into the Markdown the
 * model wrote. The failures this guards against are all the same shape: the
 * markup is pretty-printed, so every element holds whitespace text nodes its
 * author never typed, and glueing a Markdown marker onto that raw inner text
 * produces something that is no longer the message.
 *
 * Seen live, in a captured session: every bullet came back as a lone "- " on
 * one line with its content on the next, and every numbered list came back
 * unnumbered. That text is what compaction re-sends as the handover brief, so
 * a mangled list is not cosmetic — it is what the model reads next.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { EXTRACT_MESSAGE } = require("../dist/chatgpt/browser-client");

// --- the smallest DOM the walk actually touches ----------------------------

function text(value) {
  return { nodeType: 3, textContent: value };
}

function el(tag, children = [], attrs = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    className: attrs.class || "",
    querySelector(selector) {
      const wanted = selector.toUpperCase();
      const walk = (n) => {
        for (const child of n.childNodes || []) {
          if (child.nodeType !== 1) continue;
          if (child.tagName === wanted) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
  };
  Object.defineProperty(node, "textContent", {
    get() {
      let out = "";
      for (const child of node.childNodes) out += child.textContent || "";
      return out;
    },
  });
  return node;
}

/**
 * An element as ChatGPT's renderer emits it: indented, with a newline and
 * padding text node between every pair of tags. This padding is the whole
 * bug — a test built from tightly packed nodes passes against the broken
 * extractor and proves nothing.
 */
function pretty(tag, children, attrs) {
  const spaced = [text("\n    ")];
  for (const child of children) spaced.push(child, text("\n    "));
  return el(tag, spaced, attrs);
}

const extract = (node) => EXTRACT_MESSAGE(node);

// --- lists -----------------------------------------------------------------

test("a bullet keeps its content on the same line as the marker", () => {
  const list = pretty("ul", [
    pretty("li", [el("p", [text("Responsive dark-green visual design")])]),
    pretty("li", [el("p", [text("Google Fonts import")])]),
  ]);

  assert.equal(
    extract(list),
    "- Responsive dark-green visual design\n- Google Fonts import"
  );
});

test("an ordered list is numbered, not bulleted", () => {
  const list = pretty("ol", [
    pretty("li", [el("p", [text("What the user asked for")])]),
    pretty("li", [el("p", [text("What you have already done")])]),
    pretty("li", [el("p", [text("What is still outstanding")])]),
  ]);

  assert.equal(
    extract(list),
    "1. What the user asked for\n2. What you have already done\n3. What is still outstanding"
  );
});

test("an ordered list resumes from its start attribute", () => {
  const list = pretty(
    "ol",
    [pretty("li", [el("p", [text("fourth")])]), pretty("li", [el("p", [text("fifth")])])],
    { start: "4" }
  );

  assert.equal(extract(list), "4. fourth\n5. fifth");
});

test("an item holding nothing but layout whitespace is dropped", () => {
  const list = pretty("ul", [
    pretty("li", [el("p", [text("kept")])]),
    pretty("li", [el("div", [text("   ")])]),
  ]);

  assert.equal(extract(list), "- kept");
});

test("inline markers inside an item survive the trim", () => {
  const list = pretty("ul", [
    pretty("li", [
      el("p", [
        text("run "),
        el("code", [text("npm test")]),
        text(" and check "),
        el("strong", [text("every")]),
        text(" case"),
      ]),
    ]),
  ]);

  assert.equal(extract(list), "- run `npm test` and check **every** case");
});

// --- the invariant the list branch exists to protect -----------------------

test("a fenced block inside a list item still starts at column 0", () => {
  // Correct Markdown would indent a continuation line under its marker. We
  // deliberately do not: the turn parser looks for an ```onflip fence at the
  // start of a line, so indenting one would turn a tool call into prose and
  // silently run nothing.
  const code = el("code", [text('tool: read\npath: style.css')], {
    class: "language-onflip",
  });
  const list = pretty("ol", [
    pretty("li", [el("p", [text("Read the file")]), el("pre", [code])]),
  ]);

  const out = extract(list);
  const fences = out.split("\n").filter((line) => line.includes("```"));

  assert.equal(fences.length, 2);
  for (const fence of fences) {
    assert.equal(fence, fence.trimStart(), `fence was indented: ${JSON.stringify(fence)}`);
  }
  assert.ok(out.includes("```onflip\ntool: read"));
});

// --- the same whitespace problem, elsewhere --------------------------------

test("a heading does not strand its hashes on their own line", () => {
  assert.equal(extract(pretty("h2", [text("Outstanding")])), "## Outstanding");
});

test("a blockquote does not strand its marker", () => {
  assert.equal(extract(pretty("blockquote", [el("p", [text("careful here")])])), "> careful here");
});

test("paragraphs are still separated from one another", () => {
  const body = pretty("div", [
    el("p", [text("first")]),
    el("p", [text("second")]),
  ]);

  assert.equal(extract(body), "first\n\nsecond");
});
