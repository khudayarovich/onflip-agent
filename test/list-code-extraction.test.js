"use strict";

/**
 * A code block inside a list item comes back as a code block.
 *
 * DeepSeek and Qwen read each list item as inline text, and a code block is
 * not inline. A model that numbers its steps — "1. Read the config:" with the
 * onflip block under it, which is how models write plans — had the block
 * flattened into the item: `Read the config:onflipCopyDownloadtool: read
 * path: config.json`, one line, no fence. parseTurn saw no call, the step
 * silently did not happen, and nothing anywhere said so. On Qwen the gutter's
 * line numbers were glued in as well.
 *
 * The page scripts are run here against a small hand-built DOM in the shapes
 * the two sites render: DeepSeek's `div.md-code-block` (a banner holding the
 * language and the Copy/Download buttons, then the `pre`), and Qwen's Monaco
 * editor (a gutter of line numbers beside `.view-lines`).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const deepseek = require("../dist/providers/deepseek/extract");
const qwen = require("../dist/providers/qwen/extract");
const { parseTurn } = require("../dist/agent/protocol");

// --- the smallest DOM the two page scripts touch ---------------------------

class Text {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
}

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    this.style = { top: attrs.top || "" };
    for (const k of kids) {
      const node = typeof k === "string" ? new Text(k) : k;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get classList() {
    const list = (this.attrs.class || "").split(/\s+/).filter(Boolean);
    return Object.assign(list, { contains: (c) => list.includes(c) });
  }
  get className() {
    return this.attrs.class || "";
  }
  getAttribute(name) {
    return name in this.attrs ? String(this.attrs[name]) : null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  get innerText() {
    return this.attrs.innerText !== undefined ? this.attrs.innerText : this.textContent;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matchCompound(el, compound) {
  const tag = /^[a-z][a-z0-9]*/i.exec(compound);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const m of compound.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(m[1])) return false;
  for (const m of compound.matchAll(/\[class\*="([^"]+)"\]/g)) if (!el.className.includes(m[1])) return false;
  return true;
}

/** Selector lists, descendant combinators, tags, classes and `[class*=]`. */
function matches(el, selector) {
  return selector.split(",").some((one) => {
    const parts = one.trim().split(/\s+/);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let a = el.parentNode; i >= 0 && a; a = a.parentNode) {
      if (a.nodeType === 1 && matchCompound(a, parts[i])) i--;
    }
    return i < 0;
  });
}

const h = (tag, attrs, kids) => new El(tag, attrs, kids);

function run(script, root) {
  const html = h("html", {}, [root]);
  const document = {
    querySelectorAll: (s) => html.querySelectorAll(s),
    querySelector: (s) => html.querySelector(s),
  };
  return new Function("document", "return " + script)(document);
}

// --- the two sites' shapes --------------------------------------------------

/** DeepSeek: div.md-code-block > banner ("onflip", Copy, Download) + pre. */
const dsBlock = (lang, code) =>
  h("div", { class: "md-code-block" }, [
    // innerText as a browser reports it: one line per block-level child.
    h("div", { class: "md-code-block-banner", innerText: `${lang}\nCopy\nDownload` }, [
      h("span", {}, [lang]),
      h("div", {}, [h("button", {}, ["Copy"]), h("button", {}, ["Download"])]),
    ]),
    h("pre", {}, [code]),
  ]);

const dsReply = (...kids) =>
  h("div", { class: "ds-markdown ds-assistant-message-main-content" }, kids);

const deepseekMarkdown = (root) => deepseek.toMarkdown(run(deepseek.EXTRACT_REPLY, root));

/** Qwen: a Monaco editor per block — a gutter of numbers beside .view-lines. */
const qwBlock = (lang, lines) =>
  h("pre", { class: "qwen-markdown-code" }, [
    h("div", { class: "qwen-markdown-code-header" }, [h("span", {}, [lang])]),
    h("div", { class: `qwen-markdown-code-body ${lang}` }, [
      h("div", { class: "margin" }, lines.map((_, i) => h("div", { class: "line-numbers" }, [String(i + 1)]))),
      h(
        "div",
        { class: "view-lines" },
        lines.map((l, i) => h("div", { class: "view-line", top: `${i * 19}px` }, [h("span", {}, [l])]))
      ),
    ]),
  ]);

const qwReply = (...kids) =>
  h("div", { class: "qwen-chat-message-assistant" }, [h("div", { class: "qwen-markdown" }, kids)]);

const qwenMarkdown = (root) => qwen.toMarkdown(qwen.normalizeNodes(run(qwen.EXTRACT_REPLY, root)));

const TOOLS = ["read", "web_fetch", "bash"];

// --- DeepSeek ----------------------------------------------------------------

test("DeepSeek: a numbered plan with a block under each step keeps both calls", () => {
  const md = deepseekMarkdown(
    dsReply(
      h("ol", {}, [
        h("li", {}, [h("p", {}, ["Read the config:"]), dsBlock("onflip", "tool: read\npath: config.json")]),
        h("li", {}, [
          h("p", {}, ["Then fetch the docs:"]),
          dsBlock("onflip", "tool: web_fetch\nurl: https://example.com/docs"),
        ]),
      ])
    )
  );
  assert.ok(!/CopyDownload/.test(md), `the banner's buttons are not content:\n${md}`);
  const turn = parseTurn(md, TOOLS);
  assert.deepEqual(
    turn.calls.map((c) => [c.tool, c.arguments]),
    [
      ["read", { path: "config.json" }],
      ["web_fetch", { url: "https://example.com/docs" }],
    ]
  );
  assert.equal(turn.malformed ?? false, false);
  // The numbering carries on across the lifted block rather than restarting.
  assert.match(md, /^1\. Read the config:$/m);
  assert.match(md, /^2\. Then fetch the docs:$/m);
});

test("DeepSeek: words after the block stay after it, and are not a new item", () => {
  const md = deepseekMarkdown(
    dsReply(
      h("ol", {}, [
        h("li", {}, [
          h("p", {}, ["Run the tests:"]),
          dsBlock("onflip", "tool: bash\ncommand: npm test"),
          h("p", {}, ["Then read what failed."]),
        ]),
        h("li", {}, [h("p", {}, ["Fix it."])]),
      ])
    )
  );
  assert.equal(
    md,
    [
      "1. Run the tests:",
      "",
      "```onflip",
      "tool: bash",
      "command: npm test",
      "```",
      "",
      "Then read what failed.",
      "",
      "2. Fix it.",
    ].join("\n")
  );
});

test("DeepSeek: a list with no blocks reads exactly as it did", () => {
  // The false-positive half. Inline formatting that sits directly in the
  // item — no <p> around it — is still read as formatting, and an ordinary
  // list is one list.
  const md = deepseekMarkdown(
    dsReply(
      h("ul", {}, [
        h("li", {}, ["Run ", h("code", {}, ["npm test"]), " ", h("strong", {}, ["first"])]),
        h("li", {}, [h("p", {}, ["then ", h("em", {}, ["ship"])])]),
      ]),
      h("ol", {}, [h("li", {}, ["one"]), h("li", {}, ["two"])])
    )
  );
  assert.equal(md, "- Run `npm test` **first**\n- then *ship*\n\n1. one\n2. two");
});

test("DeepSeek: a list that starts at 3 is numbered from 3", () => {
  // What a renderer emits for the second half of a plan the model split
  // around an unindented block itself.
  const md = deepseekMarkdown(dsReply(h("ol", { start: "3" }, [h("li", {}, ["three"]), h("li", {}, ["four"])])));
  assert.equal(md, "3. three\n4. four");
});

test("DeepSeek: a nested list is not glued onto its parent's words", () => {
  // Read inline, "Parent" and "child" came back as "Parentchild".
  const md = deepseekMarkdown(
    dsReply(h("ul", {}, [h("li", {}, ["Parent", h("ul", {}, [h("li", {}, ["child"])])]), h("li", {}, ["next"])]))
  );
  assert.equal(md, "- Parent\n\n- child\n\n- next");
});

test("DeepSeek: an autolinked URL is the URL the model wrote", () => {
  // The model drops the fence (see AGENTS.md); the renderer then turned the
  // bare URL into a link, and "[url](url)" reached web_fetch as the URL.
  const md = deepseekMarkdown(
    dsReply(
      h("p", {}, [
        "tool: web_fetch\nurl: ",
        h("a", { href: "https://example.com/docs" }, ["https://example.com/docs"]),
      ])
    )
  );
  const turn = parseTurn(md, TOOLS);
  assert.deepEqual(turn.calls.map((c) => c.arguments), [{ url: "https://example.com/docs" }]);
});

test("DeepSeek: a link the model wrote as a link stays a link", () => {
  const md = deepseekMarkdown(
    dsReply(h("p", {}, ["See ", h("a", { href: "https://example.com/docs" }, ["the docs"]), "."]))
  );
  assert.equal(md, "See [the docs](https://example.com/docs).");
});

test("DeepSeek: a non-ASCII URL is compared as the text it was written in", () => {
  // The href arrives percent-encoded; the visible text does not.
  const md = deepseekMarkdown(
    dsReply(
      h("p", {}, [
        h("a", { href: "https://uz.wikipedia.org/wiki/%D0%A2%D0%BE%D1%88%D0%BA%D0%B5%D0%BD%D1%82" }, [
          "https://uz.wikipedia.org/wiki/Тошкент",
        ]),
      ])
    )
  );
  assert.equal(md, "https://uz.wikipedia.org/wiki/Тошкент");
});

// --- Qwen --------------------------------------------------------------------

test("Qwen: a block inside a list item keeps its call, without the gutter", () => {
  const md = qwenMarkdown(
    qwReply(
      h("ol", {}, [
        h("li", {}, [h("div", {}, ["Read the config:"]), qwBlock("onflip", ["tool: read", "path: config.json"])]),
        h("li", {}, [h("div", {}, ["Then run it:"]), qwBlock("onflip", ["tool: bash", "command: node ."])]),
      ])
    )
  );
  const turn = parseTurn(md, TOOLS);
  assert.deepEqual(
    turn.calls.map((c) => [c.tool, c.arguments]),
    [
      ["read", { path: "config.json" }],
      ["bash", { command: "node ." }],
    ]
  );
  assert.match(md, /^1\. Read the config:$/m);
  assert.match(md, /^2\. Then run it:$/m);
});

test("Qwen: a list with no blocks reads exactly as it did", () => {
  const md = qwenMarkdown(
    qwReply(
      h("ul", {}, [
        h("li", {}, [h("div", {}, ["Run ", h("code", {}, ["npm test"])])]),
        h("li", {}, [h("div", {}, ["then ", h("strong", {}, ["ship"])])]),
        h("li", {}, ["and ", h("code", {}, ["git push"])]),
      ])
    )
  );
  assert.equal(md, "- Run `npm test`\n- then **ship**\n- and `git push`");
});

test("Qwen: an autolinked URL is the URL the model wrote", () => {
  const md = qwenMarkdown(
    qwReply(
      h("div", {}, [
        "tool: web_fetch\nurl: ",
        h("a", { href: "https://example.com/docs" }, [
          "https://example.com/docs",
          h("span", { class: "anticon" }, ["↗"]),
        ]),
      ])
    )
  );
  const turn = parseTurn(md, TOOLS);
  assert.deepEqual(turn.calls.map((c) => c.arguments), [{ url: "https://example.com/docs" }]);
});
