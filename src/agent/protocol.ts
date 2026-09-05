import { randomUUID } from "node:crypto";
import { ChatMessage, ToolCall } from "../types";

/**
 * Tool-call protocol.
 *
 * The model here is a ChatGPT *web* session, which has no native function
 * calling, so the contract has to survive plain text — and worse, plain text
 * that has been through a Markdown renderer and back.
 *
 * Two failures drove the current design:
 *
 * 1. **Escaping.** Asking a chat model to JSON-escape a shell command reliably
 *    fails. `-Filter "DriveType=3"` inside a JSON string breaks the string, the
 *    call does not parse, and the raw JSON gets shown to the user as though it
 *    were an answer. So the documented form is a block format with no escaping
 *    at all: values run to the end of the line, or are indented under `key: |`.
 *
 * 2. **Rendering.** A tool call written as bare prose gets Markdown-processed
 *    on the way into the DOM — `$_.Size` loses its underscores to emphasis, and
 *    unknown tags get stripped. Fencing the call keeps it verbatim.
 *
 * JSON and the older tag form are still accepted inside an explicit OnFlip
 * fence or tag. Unmarked JSON is prose: executing examples from an ordinary
 * answer would cross the model-to-machine trust boundary.
 */

export const FENCE_TAG = "onflip";
export const TOOL_OPEN = "<onflip:tool>";
export const TOOL_CLOSE = "</onflip:tool>";

export function newMessage(
  role: ChatMessage["role"],
  content: string,
  extra?: Partial<ChatMessage>
): ChatMessage {
  return { id: randomUUID(), role, content, createdAt: Date.now(), ...extra };
}

export interface ParsedTurn {
  /** Prose the model produced alongside any tool calls. */
  text: string;
  calls: ToolCall[];
  /**
   * Set when the reply clearly tried to call a tool but could not be parsed.
   * The loop turns this into a correction rather than showing the user the
   * broken call as if it were an answer.
   */
  malformed?: string;
}

/**
 * The names the registry answers to, or a predicate over them.
 *
 * Gates the recovery paths that read calls out of *unmarked* text — an
 * unfenced `tool:` line, a bare JSON object, a collapsed block. Those run over
 * prose, and prose mentions tools: "Tool: ripgrep / Purpose: fast search" is a
 * comparison, not two calls, and "Fastest tool: ripgrep." is not a call to
 * `ripgrep.`. A fenced or tagged call is the model saying "this is a call" and
 * is taken at its word, so an unknown name there still reaches the registry
 * and gets its "unknown tool" answer.
 */
export type KnownTools = Set<string> | string[] | ((name: string) => boolean);

function toPredicate(knownTools: KnownTools | undefined): (name: string) => boolean {
  if (knownTools === undefined) return () => true;
  if (typeof knownTools === "function") return knownTools;
  const names = new Set([...knownTools].map((name) => name.toLowerCase()));
  return (name) => names.has(name.trim().toLowerCase());
}

/** The tool name as written on a `tool:` line, without any quoting. */
function bareToolName(value: string): string {
  return value.trim().replace(/^[`"']+|[`"']+$/g, "").trim();
}

/** Extract every tool call in a model reply, plus the surrounding prose. */
export function parseTurn(raw: string, knownTools?: KnownTools): ParsedTurn {
  const calls: ToolCall[] = [];
  const problems: string[] = [];
  const known = toPredicate(knownTools);
  let text = raw;

  // ---- 1. fenced ```onflip blocks (the documented form) -------------------
  // An untagged fence is accepted too when its first line is `tool:` naming
  // a tool the registry knows: ChatGPT's renderer shows a fence's language
  // as a header label rather than keeping it on the code, so a reply full
  // of correct blocks came back as plain fences and ran nothing.
  const untaggedCall = (body: string): boolean => {
    const first = body.split("\n").find((line) => line.trim());
    const m = first ? /^\s*tool\s*:\s*([A-Za-z0-9_.-]+)\s*$/i.exec(first) : null;
    return Boolean(m && known(m[1]));
  };
  text = replaceFences(
    text,
    [FENCE_TAG, "onflip:tool"],
    (body) => {
      const parsed = parseCallBody(body, problems);
      if (!parsed) return null;
      calls.push(...parsed);
      return "";
    },
    untaggedCall
  );

  // ---- 2. <onflip:tool> tags ---------------------------------------------
  text = replaceTagged(text, TOOL_OPEN, TOOL_CLOSE, (body) => {
    const parsed = parseCallBody(body, problems);
    if (!parsed) return null;
    calls.push(...parsed);
    return "";
  });

  // ---- 3. unfenced block-form calls ----------------------------------------
  // Models routinely emit blocks correctly but drop the fence, and they batch
  // several in one reply. Each `tool:` at the start of a line opens a new one.
  if (calls.length === 0) {
    const { calls: unfenced, prose } = parseUnfencedBlocks(text, known);
    if (unfenced.length) {
      calls.push(...unfenced);
      text = prose;
    }
  }

  // ---- 3b. a bare JSON call, fence and all ---------------------------------
  // The JSON form is documented as living inside the fence, and the fence is
  // exactly what the page's Markdown renderer sometimes eats: a reply
  // arrived as the word "onflip" on one line and `{"tool":"todo_write",…}`
  // on the next. Nothing matched it, so 300 characters of JSON went to the
  // user as the agent's final answer and the turn ended with the plan
  // unfinished. Same acceptance as inside the fence, only when nothing else
  // parsed.
  if (calls.length === 0) {
    const { calls: bare, prose } = parseBareJsonCalls(text, known);
    if (bare.length) {
      calls.push(...bare);
      text = prose;
    }
  }

  // ---- 4. a whole reply that is one flattened block ------------------------
  // Nothing above matched and the reply has no line structure left to match
  // against — recover it as a collapsed block rather than losing the call.
  if (
    calls.length === 0 &&
    !text.includes("\n") &&
    !/(?:```|~~~)/.test(text) &&
    /\btool\s*:\s*\w/i.test(text)
  ) {
    const collapsed = parseCollapsedBlock(text);
    if (collapsed && collapsed.every((call) => known(call.tool))) {
      calls.push(...collapsed);
      text = "";
    }
  }

  const tidied = tidy(text);

  // ---- 5. an attempt that did not parse -----------------------------------
  if (calls.length === 0) {
    const attempt = detectAttempt(raw, problems, known);
    if (attempt) return { text: tidied, calls, malformed: attempt };
  }

  return { text: tidied, calls };
}

// ---------------------------------------------------------------------------
// block format
// ---------------------------------------------------------------------------

/**
 * Parse the escaping-free block form:
 *
 *   tool: bash
 *   description: check the disk
 *   command: |
 *     Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
 *
 * A value either runs to the end of its line, or — after `key: |` — is the
 * indented block that follows. Neither needs quoting or escaping, which is the
 * entire point.
 */
export function parseBlockCall(body: string): ToolCall[] | null {
  const lines = dedent(body.replace(/\r\n/g, "\n")).split("\n");
  const args: Record<string, unknown> = {};
  let toolName = "";
  let seenKey = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const match = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (!match) {
      // Stray prose before the first key is tolerated. After it, an
      // unparseable line ends the block rather than voiding it — a leftover
      // fence marker or a trailing sentence should not discard a call that is
      // otherwise complete.
      if (!seenKey) continue;
      break;
    }

    const key = match[1].toLowerCase();
    const rest = match[2];
    seenKey = true;

    // Block scalar: take the indented lines that follow, verbatim.
    if (/^[|>][-+]?$/.test(rest.trim())) {
      const collected: string[] = [];
      let j = i + 1;
      let indent: number | null = null;
      for (; j < lines.length; j++) {
        const candidate = lines[j];
        if (!candidate.trim()) {
          collected.push("");
          continue;
        }
        const leading = candidate.length - candidate.replace(/^[ \t]*/, "").length;
        if (indent === null) {
          // The first non-blank line sets the block's indent. A block scalar
          // with no indented body at all is malformed.
          if (leading === 0) break;
          indent = leading;
        } else if (leading < indent) {
          break;
        }
        collected.push(candidate.slice(indent));
      }
      i = j - 1;
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
      const value = collected.join("\n");
      if (key === "tool") {
        toolName = value.trim();
      } else {
        // Models put a JSON array inside a block scalar when an argument is
        // structured (`todos: |` with a task list). Leaving it as text hands
        // the tool a string where it needs an array.
        args[key] = maybeJson(value);
      }
      continue;
    }

    // A bare key followed by indented `- ` items is a list of objects. This is
    // how `todo_write` gets its task list, and without it the tool receives an
    // empty argument and rejects the call.
    if (rest.trim() === "" && isListAhead(lines, i + 1)) {
      const { items, next } = parseList(lines, i + 1);
      i = next - 1;
      args[key] = items;
      continue;
    }

    const value = coerce(rest.trim());
    if (key === "tool" || key === "tool_name" || key === "name") {
      if (!toolName) toolName = String(value).trim();
    } else {
      args[key] = value;
    }
  }

  if (!toolName) return null;
  // `description` is documentation for the user, and every tool that takes one
  // declares it, so it is passed through untouched.
  return [{ tool: toolName, arguments: args, id: randomUUID() }];
}

/**
 * Strip the indentation a block shares.
 *
 * A fence inside a numbered list is indented with the list, and the model
 * keeps that indent on every line of the call. Keys are matched at column 0,
 * so the first line parsed once its own indent was trimmed and the rest did
 * not — a call whose arguments were silently dropped. The first non-blank
 * line sets the indent, and a block scalar is then measured against that.
 */
function dedent(body: string): string {
  const lines = body.split("\n");
  const first = lines.find((line) => line.trim());
  if (!first) return body;
  const indent = (first.match(/^[ \t]*/) ?? [""])[0].length;
  if (indent === 0) return body;
  const leading = new RegExp(`^[ \\t]{0,${indent}}`);
  return lines.map((line) => line.replace(leading, "")).join("\n");
}

/**
 * Split a reply into consecutive unfenced blocks.
 *
 * Each `tool:` at the start of a line opens a block and closes the previous
 * one. Treating the first `tool:` as opening a block that runs to the end of
 * the reply loses every call after the first, which is what happens whenever
 * the model batches — and batching is behaviour the prompt actively asks for.
 */
function parseUnfencedBlocks(
  text: string,
  known: (name: string) => boolean
): { calls: ToolCall[]; prose: string } {
  const lines = text.split("\n");
  const fenced = fencedLineMask(lines);
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    // A `tool:` line naming something the registry has never heard of is a
    // line of prose, not the start of a block.
    const start = line.match(/^[ \t]*tool[ \t]*:[ \t]*(\S.*)$/i);
    if (start && known(bareToolName(start[1]))) starts.push(i);
  });
  if (starts.length === 0) return { calls: [], prose: text };

  const calls: ToolCall[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const parsed = parseBlockCall(lines.slice(from, to).join("\n"));
    if (parsed) calls.push(...parsed);
  }

  // Anything before the first block was the model narrating.
  return { calls, prose: lines.slice(0, starts[0]).join("\n") };
}

/** Lines inside any Markdown fence are prose unless the fence was OnFlip's. */
/**
 * JSON tool calls sitting in the reply with no fence around them.
 *
 * Only objects that start a line are considered, and only those that name a
 * tool — the same test `parseCallBody` applies inside a fence. Lines inside
 * some *other* fence are left alone: a model quoting the protocol in a
 * ```json block is explaining it, not calling it.
 */
function parseBareJsonCalls(
  text: string,
  known: (name: string) => boolean
): { calls: ToolCall[]; prose: string } {
  const calls: ToolCall[] = [];
  const lines = text.split("\n");
  const fenced = fencedLineMask(lines);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !lines[i].trimStart().startsWith("{")) {
      kept.push(lines[i]);
      continue;
    }
    // The object may span lines; take everything up to its balanced close.
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    outer: for (let j = i; j < lines.length && j < i + 200; j++) {
      for (const ch of lines[j]) {
        if (escaped) { escaped = false; continue; }
        if (inString) {
          if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) { end = j; break outer; }
      }
    }
    if (end < 0) {
      kept.push(lines[i]);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.slice(start, end + 1).join("\n"));
    } catch {
      kept.push(lines[i]);
      continue;
    }
    // Stricter than inside a fence: `tool:` must be spelled out. The looser
    // aliases `toToolCall` accepts are fine when the model has already said
    // "this is a call" by fencing it, but out here `{"name":"app",…}` is a
    // package.json someone is talking about, not a call to a tool named app.
    const named =
      parsed &&
      typeof parsed === "object" &&
      ["tool", "tool_name"].some(
        (k) => typeof (parsed as Record<string, unknown>)[k] === "string"
      );
    const call = named ? toToolCall(parsed) : null;
    if (!call || !known(call.tool)) {
      kept.push(lines[i]);
      continue;
    }
    calls.push(call);
    i = end;
  }

  return { calls, prose: calls.length ? kept.join("\n") : text };
}

function fencedLineMask(lines: string[]): boolean[] {
  const mask = lines.map(() => false);
  let marker: "`" | "~" | null = null;
  let markerLength = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!marker) {
      const open = lines[i].match(/^\s*(`{3,}|~{3,})/);
      if (!open) continue;
      marker = open[1][0] as "`" | "~";
      markerLength = open[1].length;
      mask[i] = true;
      continue;
    }
    mask[i] = true;
    const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === marker && close[1].length >= markerLength) {
      marker = null;
      markerLength = 0;
    }
  }
  return mask;
}

function hasTopLevelFence(input: string, tags: string[]): boolean {
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})([^\r\n]*)$/);
    if (!open) continue;
    const info = open[2].trim().split(/\s+/, 1)[0].toLowerCase();
    if (wanted.has(info)) return true;
    const marker = open[1][0];
    const markerLength = open[1].length;
    for (i++; i < lines.length; i++) {
      const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === marker && close[1].length >= markerLength) break;
    }
  }
  return false;
}

/** Parse a value as JSON when it plainly is some, otherwise keep it as text. */
function maybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Does an indented `- ` list start at this line? */
function isListAhead(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    return /^\s+-\s+\S/.test(lines[i]);
  }
  return false;
}

/**
 * Parse an indented list of objects:
 *
 *   - content: count the lines
 *     status: in_progress
 *   - content: write the report
 *     status: pending
 *
 * A `- key: value` opens a new item; more-indented `key: value` lines belong
 * to it. A list of bare scalars (`- one`) is returned as strings.
 */
function parseList(lines: string[], from: number): { items: unknown[]; next: number } {
  const items: unknown[] = [];
  let current: Record<string, unknown> | null = null;
  let i = from;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const bullet = line.match(/^\s+-\s+(.*)$/);
    if (bullet) {
      const body = bullet[1];
      const pair = body.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
      if (pair) {
        current = { [pair[1].toLowerCase()]: coerce(pair[2].trim()) };
        items.push(current);
      } else {
        current = null;
        items.push(coerce(body.trim()));
      }
      continue;
    }

    // A continuation line for the item currently being built.
    const pair = line.match(/^\s+([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (pair && current) {
      current[pair[1].toLowerCase()] = coerce(pair[2].trim());
      continue;
    }
    break;
  }

  return { items, next: i };
}

/**
 * Turn a bare scalar into the type it obviously is.
 *
 * Numbers are deliberately left as strings. `content: 2` in a `write` call is
 * the *text* "2", not the number 2, and there is no way to tell the two apart
 * from the syntax alone — so the safe default for a text protocol is text, and
 * the tools coerce what they actually need (see `asNumber` in tools/util).
 * Booleans are unambiguous enough to convert here.
 */
function coerce(raw: string): unknown {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  // A value the model JSON-encoded because it contained quotes of its own:
  //
  //   old_string: "ctx.fillStyle = \"#080b18\";"
  //
  // Live behaviour, not theory: every `edit` whose target contained a double
  // quote came back encoded like this, and every one that did not came back
  // raw — so the search text never matched the file and the model burned a
  // retry each time. The backslash escapes are the tell. A value that merely
  // happens to be wrapped in quotes has none and must keep them, and a
  // Windows path like "C:\Users\me" fails to parse and falls through.
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"' && raw.includes("\\")) {
    try {
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded === "string") return decoded;
    } catch {
      /* not JSON after all — the plain-quote handling below still applies */
    }
  }

  // Strip balanced surrounding quotes, but only when they wrap the whole value
  // — a command like `echo "hi"` must keep its quotes.
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      const inner = raw.slice(1, -1);
      if (!inner.includes(first)) return inner;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// candidate dispatch
// ---------------------------------------------------------------------------

/**
 * Recover a block call whose line breaks were lost somewhere in transit.
 *
 * Text can arrive flattened — a composer that collapses newlines, a renderer
 * that emits the block as prose. The format is still recoverable because it is
 * ordered: scalar `key: value` pairs first, then at most one `key: |` whose
 * value is everything after it. So the tail is taken verbatim and only the
 * head is split on key boundaries, which keeps colons *inside* a command safe.
 */
export function parseCollapsedBlock(text: string): ToolCall[] | null {
  const flat = text.replace(/\s+/g, " ").trim().replace(/^onflip\s+/i, "");
  if (!/\btool\s*:/i.test(flat)) return null;

  const blockMarker = flat.match(/\b([A-Za-z_][\w.-]*)\s*:\s*\|\s*/);
  const head = blockMarker ? flat.slice(0, blockMarker.index) : flat;
  const tail = blockMarker ? flat.slice((blockMarker.index ?? 0) + blockMarker[0].length) : "";

  const args: Record<string, unknown> = {};
  let toolName = "";

  // Split the head at each `key:` boundary; the value is whatever precedes the
  // next one.
  const keyRe = /\b([A-Za-z_][\w.-]*)\s*:\s*/g;
  const marks: { key: string; from: number; to: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(head)) !== null) {
    marks.push({ key: m[1].toLowerCase(), from: m.index, to: m.index + m[0].length });
  }
  if (marks.length === 0) return null;

  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].from : head.length;
    const value = head.slice(mark.to, end).trim();
    if (mark.key === "tool" || mark.key === "tool_name" || mark.key === "name") {
      if (!toolName) toolName = value;
    } else if (value) {
      args[mark.key] = coerce(value);
    }
  });

  // This is a last-resort recovery running over text that may just be prose,
  // so the shape has to be convincing before it is believed: a tool name that
  // is a bare identifier, and either arguments or a block marker alongside it.
  // Without both checks a sentence like "the tool: well, it works" parses as a
  // call to a tool named "well, it works". No `.` in the name: "Fastest tool:
  // ripgrep." is a sentence, and a tool called `ripgrep.` is what it parsed as.
  if (!toolName || !/^[a-z][a-z0-9_-]{0,39}$/i.test(toolName)) return null;
  if (!blockMarker && marks.length < 2) return null;

  if (blockMarker) args[blockMarker[1].toLowerCase()] = tail.trim();
  return [{ tool: toolName, arguments: args, id: randomUUID() }];
}

/** Try every representation against one block of text. */
function parseCallBody(body: string, problems: string[]): ToolCall[] | null {
  // Dedent before trimming: trimming alone strips the first line's indent and
  // leaves every other line indented, which is exactly the broken shape.
  const trimmed = dedent(stripFences(body)).trim();
  if (!trimmed) return null;

  // JSON first: it is unambiguous when it parses.
  if (/^[[{]/.test(trimmed)) {
    const json = tryJson(trimmed);
    if (json) return json;
    problems.push("the JSON in the block could not be parsed — most likely an unescaped quote or backslash inside a string");
  }

  const block = parseBlockCall(trimmed);
  if (block) return block;

  // Several concatenated JSON objects.
  const objects = findJsonObjects(trimmed);
  if (objects.length > 1) {
    const calls: ToolCall[] = [];
    for (const o of objects) {
      const parsed = tryJson(o.json);
      if (parsed) calls.push(...parsed);
    }
    if (calls.length) return calls;
  }
  if (objects.length === 1) {
    const parsed = tryJson(objects[0].json);
    if (parsed) return parsed;
  }

  if (/^[[{]/.test(trimmed) || /"tool"\s*:/.test(trimmed)) {
    problems.push("a tool block was present but neither JSON nor `key: value` lines could be read from it");
  }
  return null;
}

function tryJson(text: string): ToolCall[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON.parse(repairJson(text));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    const calls = value.map(toToolCall).filter((c): c is ToolCall => c !== null);
    return calls.length ? calls : null;
  }
  const single = toToolCall(value);
  return single ? [single] : null;
}

function toToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const name =
    pickString(obj, "tool") ??
    pickString(obj, "tool_name") ??
    pickString(obj, "name") ??
    pickString(obj, "function") ??
    pickString(obj, "action");
  if (!name) return null;

  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? obj.params;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    try {
      const inner = JSON.parse(rawArgs);
      if (inner && typeof inner === "object") args = inner as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs as Record<string, unknown>;
  } else {
    // No arguments container at all: the model wrote the arguments beside the
    // tool name, `{"tool": "todo_write", "todos": [...]}`. Live, and it used
    // to yield a call with empty arguments — which is a tool run with the
    // user's work silently missing. Everything that is not a name key is an
    // argument.
    const NAME_KEYS = new Set(["tool", "tool_name", "name", "function", "action", "type"]);
    for (const [key, value] of Object.entries(obj)) {
      if (!NAME_KEYS.has(key)) args[key] = value;
    }
  }

  return { tool: name, arguments: args, id: randomUUID() };
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// fence and tag scanning
// ---------------------------------------------------------------------------

/** Replace fenced blocks whose info string matches one of `tags`. */
function replaceFences(
  input: string,
  tags: string[],
  fn: (body: string) => string | null,
  /** Accept a fence with no language when its body passes this check. */
  untagged?: (body: string) => boolean
): string {
  const wanted = new Set(tags.map((t) => t.toLowerCase()));
  const lines = input.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})([^\r\n]*)$/);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const info = open[2].trim().split(/\s+/, 1)[0].toLowerCase();

    const marker = open[1][0];
    const markerLength = open[1].length;
    /**
     * An `onflip` fence closed with two backticks still closes.
     *
     * Markdown wants the closing fence to be at least as long as the opener,
     * and models miscount. Live, in one session, a block ended `` instead of
     * ``` — the scan ran straight past it, swallowed the *next* block's
     * opening fence into this body, and produced one call where the model had
     * written two. No error, no `malformed`: the second call simply never
     * happened, and had to be sent again on the following turn.
     *
     * Loosened only for fences we own, and only at column 0. An ordinary code
     * fence keeps the strict rule, because a two-backtick line inside a
     * Markdown sample is ordinary content. The indentation rule is what makes
     * the short close safe even inside our own blocks: a `key: |` body is
     * always indented, so an unindented `` can only be a fence — writing a
     * file whose content contains a bare `` line would otherwise have closed
     * the block early and truncated it.
     */
    const ours = wanted.has(info);
    const closeRe = ours ? /^(`{2,}|~{2,})\s*$|^\s*(`{3,}|~{3,})\s*$/ : /^\s*(`{3,}|~{3,})\s*$/;
    const minClose = ours ? 2 : markerLength;
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const close = lines[j].match(closeRe);
      // Two alternatives when the fence is ours (unindented short, or the
      // ordinary indented long one), so take whichever group matched.
      const fence = close ? (close[1] ?? close[2]) : undefined;
      if (fence && fence[0] === marker && fence.length >= minClose) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }

    // Treat every ordinary fence as opaque prose. Otherwise a literal
    // ```onflip example nested inside a longer fence becomes executable.
    const accepted = wanted.has(info) || (info === "" && untagged?.(body.join("\n")) === true);
    if (!accepted) {
      out.push(lines[i], ...body);
      if (closed) out.push(lines[j]);
      i = closed ? j : lines.length;
      continue;
    }

    // An unterminated fence is still worth reading — models truncate.
    const replacement = fn(body.join("\n"));
    if (replacement === null) {
      out.push(lines[i], ...body);
      if (closed) out.push(lines[j]);
    } else if (replacement) {
      out.push(replacement);
    }
    i = closed ? j : lines.length;
  }
  return out.join("\n");
}

/** Replace every open/close delimited region, letting the callback opt out. */
function replaceTagged(
  input: string,
  open: string,
  close: string,
  fn: (body: string) => string | null
): string {
  const lines = input.split("\n");
  const fenced = fencedLineMask(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const insideFence = fenced[i];
    let j = i + 1;
    while (j < lines.length && fenced[j] === insideFence) j++;
    const chunk = lines.slice(i, j).join("\n");
    out.push(insideFence ? chunk : replaceTaggedChunk(chunk, open, close, fn));
    i = j;
  }
  return out.join("\n");
}

function replaceTaggedChunk(
  input: string,
  open: string,
  close: string,
  fn: (body: string) => string | null
): string {
  let out = "";
  let rest = input;
  for (;;) {
    const start = rest.indexOf(open);
    if (start === -1) break;
    const bodyStart = start + open.length;
    const end = rest.indexOf(close, bodyStart);
    // An unclosed tag at the end of a reply still carries a usable body.
    const body = end === -1 ? rest.slice(bodyStart) : rest.slice(bodyStart, end);
    const replacement = fn(body);
    if (replacement === null) {
      if (end === -1) break;
      out += rest.slice(0, end + close.length);
      rest = rest.slice(end + close.length);
      continue;
    }
    out += rest.slice(0, start) + replacement;
    rest = end === -1 ? "" : rest.slice(end + close.length);
  }
  return out + rest;
}

function stripFences(s: string): string {
  return s.replace(/^\s*(`{3,}|~{3,})[\w+#.:-]*\s*\n?/, "").replace(/\n?\s*(`{3,}|~{3,})\s*$/, "");
}

/**
 * Repair the malformations that actually occur: trailing commas, and raw
 * newlines and tabs inside string literals.
 */
function repairJson(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (inString) {
      if (escape) {
        escape = false;
        out += ch;
      } else if (ch === "\\") {
        escape = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface JsonSpan {
  json: string;
  start: number;
  end: number;
}

/** Locate balanced top-level {...} spans that mention a tool-ish key. */
function findJsonObjects(text: string): JsonSpan[] {
  const spans: JsonSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = findBalancedEnd(text, i);
    if (end === -1) continue;
    const json = text.slice(i, end + 1);
    if (/"(tool|tool_name|name|function|action)"\s*:/.test(json)) {
      spans.push({ json, start: i, end: end + 1 });
      i = end;
    }
  }
  return spans;
}

function findBalancedEnd(s: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Did this reply try to call a tool and fail? Distinguishing that from an
 * ordinary prose answer is what stops a broken call being shown to the user as
 * though it were the result.
 */
function detectAttempt(
  raw: string,
  problems: string[],
  known: (name: string) => boolean
): string | null {
  const lines = raw.split("\n");
  const fenced = fencedLineMask(lines);
  const outsideFences = lines.filter((_line, index) => !fenced[index]).join("\n");
  // Same rule as the unfenced parser: a `tool:` line that names no known
  // tool is prose, and prose is not a failed attempt.
  const hasUnfencedBlock = lines.some((line, index) => {
    if (fenced[index]) return false;
    const start = line.match(/^\s*tool\s*:\s*(\w.*)$/i);
    return start !== null && known(bareToolName(start[1]));
  });
  const mentionsProtocol =
    outsideFences.includes("onflip:tool") ||
    hasTopLevelFence(raw, [FENCE_TAG, "onflip:tool"]) ||
    hasUnfencedBlock;
  if (!mentionsProtocol) return null;

  const detail = problems.length ? problems[0] : "the tool call could not be parsed";

  // Quote what actually arrived. Without it "could not be parsed" is a dead
  // end for both the model and whoever is reading the terminal — the useful
  // signal is almost always visible in the first line or two.
  const excerpt = raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return `${detail}. Nothing was executed. What arrived was: "${excerpt}${raw.length > 140 ? "…" : ""}"`;
}

function tidy(s: string): string {
  const lines = s.split("\n");
  const fenced = fencedLineMask(lines);
  return (
    lines
      // Fence scaffolding the renderer left behind after eating the backticks:
      // a lone "onflip" line is the info string, not something the model said.
      .filter(
        (line, index) =>
          fenced[index] ||
          (!/^\s*(`{3,}\s*)?onflip(:tool)?\s*`*\s*$/i.test(line) &&
            !/^\s*<\/?onflip:tool>\s*$/i.test(line))
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*[\r\n]+/, "")
      .trimEnd()
  );
}

/** Format a tool result as the user-role message fed back to the model. */
export function formatToolResult(call: ToolCall, output: string, isError: boolean): string {
  return [
    `<onflip:result tool="${call.tool}"${isError ? ' status="error"' : ""}>`,
    output,
    "</onflip:result>",
  ].join("\n");
}

/**
 * Build the text sent to a live chat for one turn.
 *
 * The browser transport reuses a single ChatGPT conversation, so the model has
 * already seen everything up to `fromIndex` and only newer messages go out.
 *
 * Assistant turns are handled by which case this is. Appending to a live
 * thread (`fromIndex > 0`) must skip them — they are the model's own replies
 * and are already above the composer. Replaying into a fresh thread
 * (`fromIndex === 0`, after a reset, a model switch, or resuming a saved
 * session) must include them, or the model sees a conversation in which it
 * apparently never said anything.
 */
export function buildTurnPrompt(
  history: ChatMessage[],
  fromIndex: number,
  opts?: {
    /**
     * Send the system prompt even though earlier history is being skipped.
     *
     * Needed when attaching to a ChatGPT conversation that already exists: the
     * thread holds the conversation but has never seen the tool protocol, and
     * without this the model would answer in prose and never call a tool.
     */
    includeSystem?: boolean;
  }
): string {
  const start = Math.max(0, fromIndex);
  const replaying = start === 0;
  const parts: string[] = [];

  if (!replaying && opts?.includeSystem) {
    const system = history.find((m) => m.role === "system");
    if (system?.content.trim()) parts.push(system.content);
  }

  for (let i = start; i < history.length; i++) {
    const msg = history[i];
    if (!msg.content.trim()) continue;

    if (msg.role === "system") {
      if (i === 0) parts.push(msg.content);
      continue;
    }
    if (msg.role === "assistant") {
      if (replaying) {
        parts.push(`<onflip:previous-reply>\n${msg.content}\n</onflip:previous-reply>`);
      }
      continue;
    }
    parts.push(msg.content);
  }

  if (replaying && history.some((m) => m.role === "assistant")) {
    parts.push(
      "[This is a replay of an earlier session into a new conversation. The <onflip:previous-reply> blocks are your own earlier replies and the tool results between them are real. Continue from where it left off.]"
    );
  }

  return parts.join("\n\n");
}
