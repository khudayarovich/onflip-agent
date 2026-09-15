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
      else if (tag === "A") out += "[" + inline(n) + "](" + (n.getAttribute("href") || "") + ")";
      else out += inline(n);
    }
    return out;
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
      const items = [...el.children]
        .filter((li) => li.tagName === "LI")
        .map((li) => inline(li).trim())
        .filter(Boolean);
      if (items.length) out.push({ kind: "list", ordered: tag === "OL", items });
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
