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
 * `repairFences` puts that back together. The DOM half is a script the page
 * runs; everything below it is pure, so the rules can be tested against the
 * shapes a real reply produced without launching a browser.
 */

export type ReplyNode =
  | { kind: "text"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string; body: string }
  | { kind: "heading"; level: number; text: string };

/**
 * Read the reply out of the page.
 *
 * Runs in the browser, so it is a string rather than a function: it has no
 * access to anything here, and nothing here can hold a reference into the
 * page. Returns the structure, not the markdown — assembling that is the
 * pure part below, where it can be tested.
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

/** Three backticks, as a value, so a template literal can hold them. */
const FENCE = "```";

/** How many fence markers a block's body contains. */
function fenceCount(body: string): number {
  return body.split("\n").filter((l) => /^\s*`{3}/.test(l)).length;
}

/** The indentation of the last unclosed fence, so its closer can match it. */
function danglingIndent(body: string): string {
  const opens: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^(\s*)`{3}/.exec(line);
    if (!m) continue;
    if (opens.length) opens.pop();
    else opens.push(m[1]);
  }
  return opens.length ? opens[opens.length - 1] : "";
}

/**
 * Put back a block the renderer split on an inner fence.
 *
 * A block whose body holds an odd number of fences was cut at one: the inner
 * closer was read as the outer block's end, and what followed became a new
 * block — empty, or tagged `text`, since the leftover was the outer closing
 * fence with nothing after it. The repair closes the inner fence at the
 * indentation it was opened with, and drops the fragment.
 *
 * Only an empty or whitespace fragment is absorbed. A following block with
 * real content is a real block, and eating it would be a worse bug than the
 * one being fixed.
 */
export function repairFences(nodes: ReplyNode[]): ReplyNode[] {
  const out: ReplyNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind !== "code" || fenceCount(node.body) % 2 === 0) {
      out.push(node);
      continue;
    }
    const next = nodes[i + 1];
    const absorb = next && next.kind === "code" && !next.body.trim();
    out.push({ ...node, body: `${node.body}
${danglingIndent(node.body)}${FENCE}` });
    if (absorb) i++;
  }
  return out;
}

/** Assemble the nodes back into markdown. */
export function toMarkdown(nodes: ReplyNode[]): string {
  const parts: string[] = [];
  for (const node of repairFences(nodes)) {
    if (node.kind === "text") parts.push(node.text);
    else if (node.kind === "heading") parts.push(`${"#".repeat(node.level)} ${node.text}`);
    else if (node.kind === "list")
      parts.push(
        node.items.map((it, n) => (node.ordered ? `${n + 1}. ${it}` : `- ${it}`)).join("\n")
      );
    else parts.push(`${FENCE}${node.lang}
${node.body}
${FENCE}`);
  }
  return parts.join("\n\n").trim();
}
