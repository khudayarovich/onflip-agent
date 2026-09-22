/**
 * Putting a rendered reply back together as the markdown the model wrote.
 *
 * Every browser-driven provider has the same problem and none of them have
 * the source. The page parses the reply, renders it, and throws the markdown
 * away; what is left on screen is HTML. OnFlip's protocol is a fenced
 * ```onflip block, so the fences have to be put back exactly, and "exactly"
 * is doing real work — a tool call that loses a line is a tool call that
 * runs wrong.
 *
 * What is provider-specific is only the reading: which selector holds the
 * reply, how that page marks a code block, where it hides the language. That
 * lives in each driver's own `extract.ts` as a script the page runs. What is
 * shared is everything after — the node shape those scripts return, the
 * fence repair, and the assembly — and it is shared because the bug it fixes
 * is not DeepSeek's. It is markdown's.
 *
 * Moved here when Qwen became the second provider to need it. Nothing in the
 * rules changed in the move; `deepseek/extract.ts` re-exports them so its
 * own callers and tests see exactly what they saw before.
 */

export type ReplyNode =
  | { kind: "text"; text: string }
  /**
   * `start` numbers an ordered list that picks up after a code block or a
   * nested list was lifted out of the item before it.
   */
  | { kind: "list"; ordered: boolean; items: string[]; start?: number }
  | { kind: "code"; lang: string; body: string }
  | { kind: "heading"; level: number; text: string };

/** Three backticks, as a value, so a template literal can hold them. */
const FENCE = "```";

/** A backtick fence longer than every fence-like line in the body. */
function enclosingFence(body: string): string {
  let longest = 2;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,})/.exec(line)?.[1];
    if (marker) longest = Math.max(longest, marker.length);
  }
  return "`".repeat(longest + 1);
}

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
        node.items
          .map((it, n) => (node.ordered ? `${(node.start ?? 1) + n}. ${it}` : `- ${it}`))
          .join("\n")
      );
    else {
      // The provider discarded the source fence. Rebuild it longer than any
      // Markdown fence carried inside the tool argument; a fixed ``` outer
      // fence is exactly how a done summary was split into unformatted text.
      const fence = enclosingFence(node.body);
      parts.push(`${fence}${node.lang}
${node.body}
${fence}`);
    }
  }
  return parts.join("\n\n").trim();
}
