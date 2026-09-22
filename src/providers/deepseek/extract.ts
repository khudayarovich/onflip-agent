/**
 * Turning a rendered DeepSeek reply back into the markdown the model wrote.
 *
 * The page does not keep the source. It parses the reply and throws the
 * markdown away, so what is on screen is HTML: paragraphs, lists, and code
 * blocks whose language survives only as a word in a banner above them. The
 * protocol OnFlip runs on is a fenced ```onflip block, so the fences have to
 * be put back exactly, and "exactly" is doing real work here — a tool call
 * that loses a line is a tool call that runs wrong.
 *
 * The awkward case, seen on the first real reply rather than imagined: a
 * fence *inside* a block. Asked to write a file whose content is a javascript
 * code block, the model produced correct markdown and DeepSeek's renderer
 * mis-parsed it, taking the inner closing fence as the end of the outer block
 * and opening a second, empty block with the leftover. Read naively, the tool
 * call silently loses the last line of the file it was writing.
 *
 * `repairFences` puts that back together. It is not DeepSeek's rule and never
 * was — it is markdown's — so it lives in `../markdown` with the rest of the
 * assembly, shared with every other page that renders a reply and discards
 * the source. What stays here is the DeepSeek-specific half: a script the
 * page runs, returning the node shape that module knows how to assemble.
 */

export { repairFences, toMarkdown, type ReplyNode } from "../markdown";

/**
 * Read the reply out of the page.
 *
 * Runs in the browser, so it is a string rather than a function: it has no
 * access to anything here, and nothing here can hold a reference into the
 * page. Returns the structure, not the markdown — assembling that is
 * `../markdown`, where it can be tested without a browser.
 */
export const EXTRACT_REPLY = `(() => {
  const els = document.querySelectorAll(".ds-markdown.ds-assistant-message-main-content");
  const root = els[els.length - 1];
  if (!root) return null;

  // Inline formatting, so that emphasis and inline code survive a round trip.
  const inline = (node) => {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
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

  const isCode = (n) => n.tagName === "PRE" || (n.classList && n.classList.contains("md-code-block"));
  const HOLDS_BLOCK = "pre, .md-code-block, ul, ol";
  const codeNode = (block) => {
    const pre = block.tagName === "PRE" ? block : block.querySelector("pre");
    return { kind: "code", lang: block.tagName === "PRE" ? "" : langOf(block), body: pre ? pre.innerText : "" };
  };

  // A list, item by item. An item's own words stay a list item; a code block
  // or a list nested inside it comes out as a node of its own, at column 0,
  // and the numbering carries on after it. Flattened into the item's text —
  // which is what reading the item as inline text did — an onflip block came
  // back as one line, "onflipCopyDownloadtool: read…", and the call was lost
  // without a word.
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
            else out.push(codeNode(n));
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

  // The language sits in a banner above the code, as its first line; the
  // words after it are the copy and download buttons.
  const langOf = (block) => {
    const banner = block.querySelector('[class*="banner"]');
    if (!banner) return "";
    const first = (banner.innerText || "").split("\\n")[0].trim();
    return /^[a-z0-9_+-]{1,20}$/i.test(first) ? first : "";
  };

  const out = [];
  for (const el of root.children) {
    const tag = el.tagName;
    if (el.classList && el.classList.contains("md-code-block")) {
      const pre = el.querySelector("pre");
      out.push({ kind: "code", lang: langOf(el), body: pre ? pre.innerText : "" });
    } else if (tag === "P") {
      const t = inline(el).trim();
      if (t) out.push({ kind: "text", text: t });
    } else if (tag === "UL" || tag === "OL") {
      pushList(el, tag === "OL", out);
    } else if (/^H[1-6]$/.test(tag)) {
      const t = inline(el).trim();
      if (t) out.push({ kind: "heading", level: Number(tag.slice(1)), text: t });
    } else {
      const t = (el.innerText || "").trim();
      if (t) out.push({ kind: "text", text: t });
    }
  }
  return out;
})()`;
