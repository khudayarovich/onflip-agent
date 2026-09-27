import { parseTurn } from "./protocol";
import type { ToolCall } from "../types";

/**
 * A code fence inside a value, and the page that cuts the block short at it.
 *
 * Found in a file OnFlip wrote on another machine: a Markdown document of
 * suggestions that stopped at 1,912 bytes, on the last line of its first
 * diagram, with that diagram's closing fence gone and every section after it
 * missing. The model had written it whole — OnFlip's own parser keeps the
 * raw reply intact — but the reply is read back off the chat's rendered page,
 * and a Markdown renderer ends a three-backtick block at the first line of
 * three backticks indented by three spaces or fewer. A `content: |` value is
 * indented by two, so the document's own "```" closing its diagram closed the
 * onflip block instead, and what came back to be run was the file up to that
 * line: written to disk as if it were the whole thing.
 *
 * Three defences, in the order they act:
 *
 *   The prompt asks for four backticks around a block whose value holds a
 *   fence of its own, which no inner three-backtick line can end.
 *
 *   On ChatGPT the reply stream carries the model's markdown exactly as
 *   written. When the page's copy of a call is a cut-short beginning of the
 *   stream's — or the page lost calls the stream still has — the stream's copy
 *   is the reply (`pageLostPartOfTheReply`).
 *
 *   Otherwise a file change whose text ends inside an open code block is not
 *   written (`endsInsideCodeBlock`): the model is asked to send it again in
 *   four backticks. A second identical send is written as it is, since a file
 *   can end inside a fence on purpose.
 *
 * One case none of the three can see after the fact: a document whose first
 * fence is a bare "```" is cut *before* it, so what arrives holds no fence at
 * all. The prompt's rule, and on ChatGPT the stream, are what cover that.
 */

/** The text values of a call, by key — nested lists of edits flattened. */
function textValues(call: Pick<ToolCall, "arguments">): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(call.arguments ?? {})) {
    if (typeof value === "string") out.set(key, value);
    else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object") {
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (typeof v === "string") out.set(`${key}[${i}].${k}`, v);
          }
        }
      });
    }
  }
  return out;
}

function normal(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
}

/**
 * Did the page's copy of the reply lose part of a call the stream still has?
 *
 * Only on evidence of loss, never on mere difference: the page's copy is
 * re-serialised from rendered HTML and can differ from the model's markdown in
 * harmless ways, and those keep the page's copy as before. Loss means the page
 * has fewer calls, or one of its values is a strict beginning of the stream's
 * — with every other value the same.
 */
export function pageLostPartOfTheReply(
  page: string,
  stream: string,
  isKnownTool?: (name: string) => boolean
): boolean {
  if (!stream.trim() || normal(stream) === normal(page)) return false;
  const ours = parseTurn(page, isKnownTool).calls;
  const theirs = parseTurn(stream, isKnownTool).calls;
  if (theirs.length === 0 || ours.length > theirs.length) return false;
  let lost = theirs.length > ours.length;
  for (let i = 0; i < ours.length; i++) {
    if (ours[i].tool.toLowerCase() !== theirs[i].tool.toLowerCase()) return false;
    const a = textValues(ours[i]);
    const b = textValues(theirs[i]);
    for (const [key, value] of a) {
      const other = b.get(key);
      if (other === undefined) return false;
      const x = normal(value);
      const y = normal(other);
      if (x === y) continue;
      if (y.length > x.length && y.startsWith(x)) {
        lost = true;
        continue;
      }
      return false;
    }
    // A value the page never had: its block ended before the key did.
    if ([...b.keys()].some((key) => !a.has(key))) lost = true;
  }
  return lost;
}

/** The values a file change writes, by key. Nothing else is judged. */
function writtenText(tool: string, args: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  if (tool === "write" && typeof args.content === "string") out.set("content", args.content);
  if (tool === "edit" && typeof args.new_string === "string") out.set("new_string", args.new_string);
  if (tool === "multi_edit" && Array.isArray(args.edits)) {
    args.edits.forEach((edit, i) => {
      const value = edit && typeof edit === "object" ? (edit as Record<string, unknown>).new_string : undefined;
      if (typeof value === "string") out.set(`edits[${i}].new_string`, value);
    });
  }
  return out;
}

/**
 * The key of a file change whose text ends inside an open code block, or
 * null. A fence opens on a line of three or more backticks (with or without
 * a language) and closes on one at least as long with nothing after it,
 * indented three spaces or fewer — CommonMark's own rule, which is the one
 * the chat's renderer applied when it cut the block.
 */
export function endsInsideCodeBlock(tool: string, args: Record<string, unknown>): string | null {
  for (const [key, value] of writtenText(tool, args)) {
    let open = 0;
    for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
      const fence = /^ {0,3}(`{3,})(.*)$/.exec(line);
      if (!fence) continue;
      if (open === 0) {
        if (!fence[2].includes("`")) open = fence[1].length;
      } else if (fence[1].length >= open && !fence[2].trim()) {
        open = 0;
      }
    }
    if (open > 0) return key;
  }
  return null;
}

/** What the model is told when a change is held back for ending inside a code block. */
export function cutBlockAdvice(tool: string, key: string, path: string): string {
  return (
    `[OnFlip] This ${tool} was not applied: its ${key}${path ? ` for ${path}` : ""} ends inside a code block — a \`\`\` fence opens and never closes. ` +
    "That is what a value looks like when the chat's renderer ended your onflip block at the first line of three backticks inside it, so the rest never arrived. " +
    "Send the call again with FOUR backticks around the block (````onflip … ````), which no line of three backticks can end. " +
    "If the text really does end inside a code block, send the same call again unchanged and it will be written as it is."
  );
}
