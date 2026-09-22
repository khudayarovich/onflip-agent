/**
 * Reading a Qwen reply back out of the page.
 *
 * Qwen renders markdown into its own tagged elements — `qwen-markdown-*` on
 * every paragraph, list, heading and span — which makes the ordinary half of
 * this easy. The code blocks are the reason this file has comments.
 *
 * Qwen does not render a fenced block as `<pre><code>`. It mounts a Monaco
 * editor: the same component VS Code is built on, one instance per block,
 * with a line-number gutter beside the text. Three things follow, and each
 * one is a way to silently corrupt a tool call.
 *
 * First, `innerText` on the block is wrong. It walks the gutter too, so a
 * two-line block reads back as `1 2 tool: probe arg: 12345` — the line
 * numbers arriving as content. The text lives in `.view-lines`, which is a
 * sibling of the gutter rather than a parent of it, so reading that element
 * is what excludes them.
 *
 * Second, Monaco positions each line absolutely and does not keep them in
 * document order. Reading `.view-line` elements in the order they appear is
 * right until the moment it is not, and the failure is silent and unordered.
 * They are sorted by their `top` offset instead.
 *
 * Third, Monaco renders a space as a non-breaking space. Left alone, every
 * indented line comes back with U+00A0 where its indentation was, which is
 * whitespace to the eye and a syntax error to Python.
 *
 * Measured against the live page rather than reasoned about: 60 lines out of
 * 60 with no gaps, and `[0, 4, 8, 12, 4]` for the indentation of a nested
 * Python function. The container grows to its content height rather than
 * scrolling, so nothing is virtualised away at that size — the worry that
 * prompted the measurement turned out to be unfounded, and the measurement
 * is what says so.
 */

import type { ReplyNode } from "../markdown";

export { repairFences, toMarkdown, type ReplyNode } from "../markdown";

/** One rendered line of a Monaco block, as the page hands it over. */
export interface CodeLine {
  /** Its pixel offset, which is the only reliable statement of its order. */
  top: number;
  text: string;
}

/** What the page script returns for a code block, before the rules below. */
export type RawNode = ReplyNode | { kind: "code"; lang: string; lines: CodeLine[] };

/**
 * Turn Monaco's rendered lines back into the text the model wrote.
 *
 * Three rules, and every one of them is a way to corrupt a tool call if it
 * is left out:
 *
 * Order comes from `top`, not from the DOM. Monaco positions lines
 * absolutely and is free to keep them in any order it likes; reading them as
 * they appear is right until it is not, and the failure is silent.
 *
 * U+00A0 becomes a space. Monaco renders indentation as non-breaking spaces,
 * which look like whitespace and are a syntax error to Python.
 *
 * Trailing blank lines go, because the renderer adds one and a fenced block
 * that gains a line every round trip is a file that gains one.
 *
 * Pure, and separate from the page script, so all three can be held against
 * real shapes without a browser. That is the whole reason it lives here
 * rather than inside the string that runs in the page.
 */
export function codeFromLines(lines: CodeLine[]): string {
  return lines
    .slice()
    .sort((a, b) => a.top - b.top)
    .map((l) => (l.text ?? "").split(" ").join(" "))
    .join("\n")
    .replace(/\s+$/, "");
}

/**
 * The page script's output, with the code blocks resolved.
 *
 * A block that arrives with `lines` came from a mounted Monaco editor; one
 * that arrives with `body` was read before Monaco mounted, mid-stream, and
 * is already plain text.
 */
export function normalizeNodes(nodes: RawNode[]): ReplyNode[] {
  return nodes.map((node) => {
    if (node.kind !== "code" || !("lines" in node)) return node as ReplyNode;
    return { kind: "code", lang: node.lang, body: codeFromLines(node.lines) };
  });
}

/**
 * Read the reply out of the page.
 *
 * Runs in the browser, so it is a string rather than a function: it has no
 * access to anything here, and nothing here can hold a reference into the
 * page. Returns the structure, not the markdown — assembling that is
 * `../markdown`, where it can be tested without a browser.
 */
export const EXTRACT_REPLY = `(() => {
  const msgs = document.querySelectorAll(".qwen-chat-message-assistant");
  const msg = msgs[msgs.length - 1];
  if (!msg) return null;
  // The answer, not the thinking. Qwen keeps its reasoning in a status card
  // of its own beside the answer rather than mixed into it, so taking the
  // answer element takes the answer alone — no prose-stripping, no guessing
  // where the thinking stopped.
  const root = msg.querySelector(".qwen-markdown") ||
    msg.querySelector(".response-message-content");
  if (!root) return null;

  // Inline formatting, so emphasis and inline code survive a round trip.
  const inline = (node) => {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      // Decorative glyphs the renderer adds of its own accord — the little
      // mark beside an external link, most often. They are markup, not
      // anything the model wrote, and they arrive as text otherwise.
      if (tag === "SVG" || tag === "svg" || (n.classList && n.classList.contains("anticon"))) continue;
      if (tag === "CODE") out += "\\u0060" + n.textContent + "\\u0060";
      else if (tag === "STRONG" || tag === "B") out += "**" + inline(n) + "**";
      else if (tag === "EM" || tag === "I") out += "*" + inline(n) + "*";
      else if (tag === "BR") out += "\\n";
      else if (tag === "A") out += link(n);
      else out += inline(n);
    }
    return out;
  };

  // A link the renderer made out of a bare URL is the URL the model wrote.
  // As "[url](url)" it reached web_fetch literally, brackets and all.
  const link = (a) => {
    const text = inline(a);
    const href = a.getAttribute("href") || "";
    const bare = (s) => {
      try { s = decodeURI(s); } catch (e) { /* keep it as it came */ }
      return s.replace(/^(https?:\\/\\/|mailto:)/i, "").replace(/\\/$/, "");
    };
    return bare(text) === bare(href) ? text : "[" + text + "](" + href + ")";
  };

  // The language is a class on the body — "qwen-markdown-code-body python" —
  // which is the one place it survives as data rather than as a word in a
  // header beside two buttons.
  const langOf = (pre) => {
    const body = pre.querySelector('[class*="qwen-markdown-code-body"]');
    if (body) {
      const found = [...body.classList].find((c) => c !== "qwen-markdown-code-body");
      if (found && /^[a-z0-9_+-]{1,20}$/i.test(found)) return found;
    }
    const header = pre.querySelector('[class*="code-header"]');
    if (!header) return "";
    const first = (header.innerText || "").split("\\n")[0].trim();
    return /^[a-z0-9_+-]{1,20}$/i.test(first) ? first : "";
  };

  // Deliberately only the reading. The gutter is excluded here — by asking
  // for .view-lines, which is the gutter's sibling rather than its parent —
  // and everything else the lines need doing to them is done in Node, by
  // \`codeFromLines\` below, where it can be tested. What comes back is each
  // line with the offset that says where it really belongs.
  const codeOf = (pre) => {
    const lines = [...pre.querySelectorAll(".view-lines .view-line")];
    if (lines.length) {
      return { lines: lines.map((el) => ({ top: parseInt(el.style.top, 10) || 0, text: el.textContent || "" })) };
    }
    // Before Monaco has mounted — mid-stream, on the first frames of a block
    // — the text is plain. Reading it is better than reporting an empty
    // block to a caller that is watching the answer grow.
    const plain = pre.querySelector("code") || pre;
    return { body: plain.innerText || "" };
  };

  const isCode = (n) => n.tagName === "PRE" || (n.classList && n.classList.contains("qwen-markdown-code"));
  const HOLDS_BLOCK = "pre, .qwen-markdown-code, ul, ol";

  // A list, item by item. An item's own words stay a list item; a code block
  // or a list nested inside it comes out as a node of its own, at column 0,
  // and the numbering carries on after it. Flattened into the item's text —
  // which is what reading the item as inline text did — an onflip block came
  // back as one line, gutter numbers and all, and the call was lost without
  // a word.
  const pushList = (list, ordered, out) => {
    const first = parseInt(list.getAttribute("start"), 10);
    let number = (ordered && Number.isFinite(first) ? first : 1) - 1;
    let items = [];
    let start = number + 1;
    const flush = () => {
      if (items.length) out.push({ kind: "list", ordered, items, start });
      items = [];
    };
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      number++;
      if (!items.length) start = number;
      let text = "";
      // Once something has been lifted out of this item, the words after it
      // are a paragraph of their own: numbering them would invent an item.
      let lifted = false;
      const settle = () => {
        const t = text.trim();
        text = "";
        if (t && lifted) out.push({ kind: "text", text: t });
        else if (t) items.push(t);
      };
      const walk = (node) => {
        for (const n of node.childNodes) {
          if (n.nodeType === 3) { text += n.nodeValue; continue; }
          if (n.nodeType !== 1) continue;
          const nested = n.tagName === "UL" || n.tagName === "OL";
          if (nested || isCode(n)) {
            settle();
            flush();
            lifted = true;
            if (nested) pushList(n, n.tagName === "OL", out);
            else out.push(Object.assign({ kind: "code", lang: langOf(n) }, codeOf(n)));
          } else {
            if ((n.tagName === "P" || n.tagName === "DIV") && text.trim()) text += " ";
            // Formatting is read as it is anywhere else — through inline(),
            // which handles the element itself and not only its children.
            if (n.querySelector(HOLDS_BLOCK)) walk(n);
            else text += inline({ childNodes: [n] });
          }
        }
      };
      walk(li);
      settle();
    }
    flush();
  };

  const out = [];
  for (const el of root.children) {
    const tag = el.tagName;
    const cls = el.classList || { contains: () => false };
    // Layout, not content: Qwen puts a spacer div between blocks.
    if (cls.contains("qwen-markdown-space")) continue;
    if (tag === "PRE" || cls.contains("qwen-markdown-code")) {
      out.push(Object.assign({ kind: "code", lang: langOf(el) }, codeOf(el)));
    } else if (/^H[1-6]$/.test(tag)) {
      const t = inline(el).trim();
      if (t) out.push({ kind: "heading", level: Number(tag.slice(1)), text: t });
    } else if (tag === "UL" || tag === "OL") {
      pushList(el, tag === "OL", out);
    } else {
      // Paragraphs are divs here rather than <p>, so this is the ordinary
      // case and not the fallback it looks like.
      const t = inline(el).trim();
      if (t) out.push({ kind: "text", text: t });
    }
  }
  return out;
})()`;
