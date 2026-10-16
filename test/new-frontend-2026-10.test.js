"use strict";

/**
 * ChatGPT's frontend of October 2026, pinned.
 *
 * Issue #1 ("ChatGPT never finishes loading", 0.10.77): every message sat on
 * "Still working" and nothing came back. Reproduced on this project's own
 * machine on 2026-10-16, on a Free and a Pro Lite account alike: the page had
 * been replaced under the app. The composer is a ProseMirror textbox labelled
 * "Ask ChatGPT" with no id; the send control is the form's submit button
 * labelled "Send" and becomes a plain "Stop" button while a reply is written;
 * the user's turn is a bubble carrying `data-user-message-bubble`; a reply is
 * an `h4[data-conversation-role='assistant']` heading followed by a markdown
 * root carrying `data-markdown-text-style='assistant-message'`; and
 * `data-message-author-role`, which every reader here keyed on, is gone. So
 * OnFlip typed and sent on the new page and then could not see the reply, the
 * user's own turn, or the stop control, and each turn ran out the stall guard.
 *
 * These are the shapes measured on the live page. A CSS engine is not part of
 * the suite, so what is pinned is that each list names the shape, in the
 * place the list's own rules put it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const S = require("../dist/chatgpt/selectors");
const { EXTRACT_MESSAGE, REVISION_ATTRIBUTES } = require("../dist/chatgpt/browser-client");

test("the composer, send and stop controls of the new page are named", () => {
  assert.ok(S.COMPOSER_SELECTORS.includes("form div[role='textbox'][contenteditable='true']"));
  assert.ok(S.SEND_SELECTORS.includes("form button[type='submit'][aria-label='Send']"));
  assert.ok(S.STOP_SELECTORS.includes("form button[aria-label='Stop']"));
  // The labelled pill leads the switcher list and keeps the shape the older
  // test demands of a first entry: scoped to the form, with aria-haspopup.
  assert.equal(S.MODEL_SWITCHER_SELECTORS[0], "form button[aria-haspopup='menu'][aria-label='Select ChatGPT model']");
});

test("replies and user turns are found without data-message-author-role", () => {
  assert.ok(S.ASSISTANT_SELECTORS.includes("[data-markdown-text-style='assistant-message']"));
  assert.ok(S.USER_TURN_SELECTORS.includes("[data-user-message-bubble='true']"));
  // The login-wall test counts message nodes of either role; it must see
  // the new ones too, or a conversation on the new page reads as a wall.
  for (const needle of ["data-user-message-bubble", "data-markdown-text-style='assistant-message'", "data-conversation-role"]) {
    assert.ok(S.ANY_MESSAGE_QUERY.includes(needle), `ANY_MESSAGE_QUERY lacks ${needle}`);
  }
  // And the mutation observer must wake for the attributes those readers key on.
  for (const attr of ["data-conversation-role", "data-markdown-text-style", "data-user-message-bubble"]) {
    assert.ok(REVISION_ATTRIBUTES.includes(attr), `REVISION_ATTRIBUTES lacks ${attr}`);
  }
});

// The smallest DOM the extractor walks, as message-extraction.test.js builds it.
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
    get: () => children.map((c) => c.textContent).join(""),
  });
  return node;
}

test("the new markdown root reads back as the reply's markdown", () => {
  // As captured: a MarkdownRoot div holding Paragraph elements, the reply's
  // text in a span. The activity header ("Worked for 26s") and the
  // "ChatGPT said:" heading sit outside this root and are not part of it.
  const root = el(
    "div",
    [
      text("\n  "),
      el("p", [el("span", [text("Hello, Farrukh! How can I help you today?")])], { class: "Paragraph-kKnbIo" }),
      text("\n  "),
      el("p", [text("Run "), el("code", [text("npm test")]), text(" first.")], { class: "Paragraph-kKnbIo" }),
      text("\n"),
    ],
    { class: "MarkdownRoot-rZKhxa", "data-markdown-text-style": "assistant-message" }
  );
  const out = EXTRACT_MESSAGE(root).trim();
  assert.equal(out, "Hello, Farrukh! How can I help you today?\n\nRun `npm test` first.");
});

test("the new code block reads back as a fence with its language and its lines", () => {
  // As captured on 2026-10-16: no <pre>; a div[data-code-block] with a header
  // holding the language label and a copy button, then the source div whose
  // <code> keeps each line in a span with a newline text node between.
  const line = (value) => el("span", [text(value)]);
  const code = el(
    "code",
    [line("tool: done"), text("\n"), line("summary: |"), text("\n"), line("  hi there")],
    { class: "whitespace-pre! block text-size-code CodeContent-y" }
  );
  const source = el("div", [code], { "data-code-block-source": "true" });
  const header = el("div", [el("span", [text("onflip")]), el("button", [text("Copy")])], { class: "flex items-center" });
  const block = el("div", [header, source], { "data-code-block": "true", "data-markdown-copy": "code-block" });
  // The label walk uses a tree walker over text nodes; give the fake DOM one.
  const texts = (n, out = []) => {
    if (n.nodeType === 3) out.push(n);
    for (const c of n.childNodes || []) texts(c, out);
    return out;
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker(root) {
      const all = texts(root);
      let i = -1;
      return { nextNode: () => all[++i] || null };
    },
  };
  for (const n of texts(block)) {
    // closest("button") is what keeps "Copy" from being read as a language.
    n.parentElement = null;
  }
  const wrap = (node, parent) => {
    for (const c of node.childNodes || []) {
      if (c.nodeType === 3) c.parentElement = node;
      wrap(c, node);
    }
  };
  wrap(block, null);
  for (const n of [block, header, source, code, ...header.childNodes, ...code.childNodes]) {
    if (n.nodeType === 1) n.closest = (sel) => (n.tagName === sel.toUpperCase() ? n : null);
  }
  // code.contains(t): the label walk stops at the first text inside the code.
  code.contains = (t) => texts(code).includes(t);
  const root = el("div", [el("div", [block], { class: "CodeBlock-zu1QM3" })], {
    "data-markdown-text-style": "assistant-message",
  });
  assert.equal(EXTRACT_MESSAGE(root).trim(), "```onflip\ntool: done\nsummary: |\n  hi there\n```");
});
