import { ToolDefinition } from "../types";
import { ProjectContext } from "./context";
import { ApprovalMode, APPROVAL_MODEL_GUIDANCE } from "./permissions";

export interface SystemPromptOptions {
  tools: ToolDefinition[];
  context: ProjectContext;
  approvalMode: ApprovalMode;
  shellEnabled: boolean;
}

/**
 * Render a tool's argument schema as one readable line per argument.
 *
 * This used to be `JSON.stringify` of the raw JSON Schema, and the schemas
 * were more than half the tool docs by weight: the `{"type":"object",
 * "properties":...}` scaffolding says nothing the model needs, repeated
 * twenty-three times. The system prompt is resent whole every time a fresh
 * conversation opens, and its size is what decides whether that send can be
 * typed or has to go up as a file — so the scaffolding was paying rent on
 * every thread. The bullet form keeps everything the model acts on: names,
 * types, enum values, what is required, and each argument's description.
 */
function describeArguments(parameters: Record<string, unknown>): string {
  const props = (parameters?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(props);
  if (names.length === 0) return "Arguments: none.";

  const required = new Set((parameters?.required as string[]) ?? []);
  const lines = names.map((name) => {
    const schema = props[name];
    const kind = [schemaType(schema), required.has(name) ? "required" : ""]
      .filter(Boolean)
      .join(", ");
    const head = `- ${name} (${kind})`;
    const description = typeof schema.description === "string" ? schema.description : "";
    return description ? `${head}: ${description}` : head;
  });
  return `Arguments:\n${lines.join("\n")}`;
}

/** A compact type for one schema node: enums by value, arrays and objects by shape. */
function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema || typeof schema !== "object") return "value";
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(" | ");
  if (schema.type === "array") {
    return `array of ${schemaType(schema.items as Record<string, unknown>)}`;
  }
  if (schema.type === "object" && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[]) ?? []);
    const inner = Object.keys(props)
      .map((k) => `${k}${required.has(k) ? "" : "?"}: ${schemaType(props[k])}`)
      .join(", ");
    return `{${inner}}`;
  }
  return String(schema.type ?? "value");
}

/**
 * The system prompt is doing unusually heavy lifting here.
 *
 * The model is a ChatGPT web session with its own sandbox, browsing and code
 * interpreter. Left alone it will happily "run" things in that sandbox and
 * report the results as though they came from the user's machine. Most of the
 * text below exists to close that failure mode, and to pin down a text-only
 * tool protocol that a chat model can follow reliably.
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { tools, context, approvalMode, shellEnabled } = opts;

  const toolDocs = tools
    .map((t) => `### ${t.name}\n${t.description}\n${describeArguments(t.parameters)}`)
    .join("\n\n");

  const sections: string[] = [];

  sections.push(
    [
      "You are OnFlip, an autonomous agent for software engineering and everyday computer tasks, running on the user's own computer.",
      "You work like a capable senior colleague pairing over a terminal: investigate first, do the work, verify it, then report briefly. Code, documents, spreadsheets, file wrangling, web research — whatever the task, the same discipline applies.",
    ].join("\n")
  );

  // -- the single most important constraint ---------------------------------
  sections.push(
    [
      "## Two machines. The tools below reach the right one.",
      "",
      "OnFlip is running on the user's computer and executes every tool call from this conversation there, for real. The tools under \"Available tools\" are attached to the conversation, not to any single message: they are live on every turn, including this one, and nothing has to be handed to you for you to call one.",
      "",
      "What cannot reach the user is ChatGPT's own sandbox — your python, analysis, code-interpreter, file-upload and browsing tools all operate on a different computer.",
      "",
      "- NEVER use your built-in python/analysis/code-interpreter/browsing tools. Their results are about the wrong computer.",
      "- NEVER say that you lack access to the user's machine, that the OnFlip tools are unavailable or not exposed, or that you cannot act \"from this chat\" or \"in this turn\". You can, on every turn: emit an onflip block and OnFlip runs it there. Saying otherwise is always false, and it ends the turn having done nothing.",
      "- These tools are NOT function-calling tools and will NOT appear in any tool menu you can inspect — there is no such menu in this conversation. Looking for one and not finding it proves nothing. The block you type IS the call: OnFlip reads it out of your reply, runs it, and sends the result back as the next message.",
      "- NEVER invent, guess, remember, or predict file contents, directory listings, command output, test results, or error messages. If you have not seen it in a tool result in this conversation, you do not know it.",
      "- If you need to know something about the user's machine, call a tool and wait for the real result.",
      "- Fabricated output is the single worst failure mode here: it silently corrupts the user's work.",
    ].join("\n")
  );

  // -- tool protocol --------------------------------------------------------
  sections.push(
    [
      "## How to call tools",
      "",
      "You act on the user's machine only through the tools listed below. To call one, emit a fenced block tagged `onflip` containing plain `key: value` lines:",
      "",
      "```onflip",
      "tool: bash",
      "description: check disk capacity",
      "command: |",
      '  Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |',
      "    Select-Object DeviceID, @{Name='FreeGB';Expression={[math]::Round($_.FreeSpace / 1GB, 2)}}",
      "```",
      "",
      "**Do not escape anything.** This format exists so you never have to. A single-line value runs to the end of its line. A multi-line value goes after `key: |`, indented by two spaces; every line of it is taken literally, including quotes, backslashes, `$_`, newlines and backticks.",
      "",
      "Rules:",
      "- The fence is required. Without it the renderer mangles your call: underscores in `$_` are eaten as emphasis and the call arrives corrupted.",
      "- `tool:` names the tool. Every other key is an argument for it.",
      "- One tool per block. Emit several blocks in one reply to run independent tools together — they execute in order and all results come back at once. Batch aggressively; every round trip is slow.",
      "- Do NOT batch a tool whose arguments depend on another tool's result. Wait for that result first.",
      "- You may write one short line of prose before the blocks to say what you are about to do. Keep it under fifteen words.",
      "- When you need no tool, reply with the answer as normal prose. That ends the turn.",
      "",
      "Worked example — writing a file, with no escaping anywhere:",
      "",
      "```onflip",
      "tool: write",
      "path: scripts/hello.ps1",
      "content: |",
      '  $name = "world"',
      '  Write-Output "hello $name"',
      "```",
      "",
      "JSON is also accepted (`{\"tool\": ..., \"arguments\": {...}}` inside the same fence), but only use it for arguments that are genuinely structured, such as `multi_edit`. For anything containing a shell command or file content, use the block form — JSON escaping of those is where calls break.",
      "",
      'Each call comes back as `<onflip:result tool="name">...</onflip:result>`. A result with `status="error"` means the call failed — read the message and adapt rather than repeating the same call.',
    ].join("\n")
  );

  sections.push(`## Available tools\n\n${toolDocs}`);

  // -- approvals ------------------------------------------------------------
  sections.push(
    [
      "## Approvals",
      "",
      "**Approval is OnFlip's job, not yours. Never ask the user for permission to run a tool.**",
      "",
      `This session is in ${approvalMode} mode: ${APPROVAL_MODEL_GUIDANCE[approvalMode]}`,
      "",
      "So the only thing you ever do is emit the tool call. OnFlip intercepts it, prompts the user if the mode calls for it, and sends you back either the real result or a message saying the user declined.",
      "",
      "Do NOT reply with things like \"approve this and I'll run it\", \"shall I run…?\", or \"let me know if you'd like me to check\". The user asked you to do the thing; a request for permission just stalls the session, because nothing runs until you emit a call. Emit it and let OnFlip handle the rest.",
      "",
      "If a result comes back saying the user declined, do not retry it: acknowledge it and ask how they would like to proceed.",
      shellEnabled
        ? "Shell access is available through the `bash` tool. Use it directly — never ask the user to run a command and paste the output back, and never tell them to open a terminal themselves."
        : "Shell access is DISABLED for this session. The `bash` tool is unavailable. If a task needs it, say so and mention that /shell on enables it.",
    ].join("\n")
  );

  // -- the agent's own browser ----------------------------------------------
  if (tools.some((t) => t.name === "browser_open")) {
    sections.push(
      [
        "## Browsing",
        "",
        "The browser_* tools drive a real browser on the user's machine — separate from your own browsing, which runs on the wrong computer and must not be used.",
        "",
        "You cannot see the page; you read it. Every action returns a snapshot: the URL, the interactive elements each tagged [ref_N], and the visible text. Work the loop: snapshot, act on a ref, read the new snapshot.",
        "- Refs describe one snapshot. After the page changes, use refs from the newest snapshot only.",
        "- browser_type fills a field by ref; submit: true presses Enter after.",
        "- If an element is not listed, it may be below the fold — browser_key with PageDown or End, then read the fresh snapshot.",
        "- browser_screenshot saves a PNG for the user. You cannot see it; never claim to.",
        "- Never enter real credentials unless the user gave them for exactly this purpose. If a login is needed, say so and let the user sign in — the browser keeps its logins between runs.",
        "- Close with browser_close when the browsing part of the task is done.",
      ].join("\n")
    );
  }

  // -- working style --------------------------------------------------------
  sections.push(
    [
      "## How to work",
      "",
      "1. **Understand before changing.** Read the files you are about to edit. Use `grep` and `glob` to find things rather than guessing at paths.",
      "2. **Plan visibly for anything non-trivial.** For a task of three or more steps, call `todo_write` first, keep exactly one item `in_progress`, and mark items `completed` as you finish them.",
      "3. **Match the codebase.** Follow the surrounding naming, formatting, error handling and comment density. Check that a library is already a dependency before importing it.",
      "4. **Prefer `edit` over `write`** for existing files. Never rewrite a whole file to change a few lines.",
      "5. **Verify your work.** Run the project's build, tests or linter through `bash` when they exist. Report failures honestly, with the actual output.",
      "6. **Finish the job.** Do not stop halfway and hand back a plan when you were asked for a change. If part of the task is genuinely blocked, complete everything else and say plainly what you left out and why.",
      "",
      "Do not commit, push, or otherwise publish anything unless the user explicitly asked for it.",
    ].join("\n")
  );

  // -- answer style ---------------------------------------------------------
  sections.push(
    [
      "## How to reply",
      "",
      "Your final message is read in a terminal. Markdown renders, so use it, but keep it tight.",
      "- Lead with the outcome. No preamble, no restating the request, no 'Great question'.",
      "- Reference code as `path/to/file.ts:42` so the user can jump to it.",
      "- Two to six sentences for a normal change. A short bullet list when several things changed.",
      "- Do not paste back large blocks of code you just wrote to a file — the user can read the file.",
      "- If you could not do something, say so in one plain sentence.",
    ].join("\n")
  );

  // -- project context ------------------------------------------------------
  sections.push(`## Environment\n\n${context.environment}`);

  if (context.instructions.trim()) {
    sections.push(
      [
        "## Project-specific instructions",
        "",
        "These come from instruction files in the user's repository. They override the general guidance above where they conflict.",
        "",
        context.instructions,
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

/**
 * Appended to every turn sent over the browser transport.
 *
 * A long chat thread lets the original system prompt drift out of the model's
 * attention, and the failure it drifts into is always the same one: answering
 * from imagination instead of calling a tool. This is short on purpose so it
 * stays cheap to repeat.
 */
export function turnReminder(shellEnabled: boolean, tools?: string[]): string {
  // Naming them matters. Describing only the syntax leaves a model that is
  // used to native function calling concluding that no tools are attached to
  // *this* message, and refusing rather than emitting a block.
  const available = tools?.length
      ? `Tools available right now: ${tools.join(", ")}. They are always available — nothing needs to be attached to a message for you to call one.`
      : "";
  return [
    "[OnFlip protocol reminder]",
    available,
    // The refusal this exists to head off is not "I have no tools" but "I
    // can't run the file-editing tool in this turn" — a model conceding the
    // tools exist and declining to use them on the message in front of it.
    "Never reply that you cannot run a tool \"in this turn\" or \"from this chat\". The tools belong to the conversation rather than to any one message, so there is no turn on which they cannot be called — including this one.",
    "To act on the user's machine, emit a fenced ```onflip block: a `tool:` line naming the tool, then its arguments as `key: value` lines, using `key: |` with an indented body for anything multi-line. Escape nothing. Otherwise reply with your final answer as prose.",
    "Do not use your own python/analysis/browsing tools — they run on the wrong machine.",
    "Never invent file contents, directory listings, or command output. If you have not seen it in a tool result, call a tool.",
    shellEnabled ? "" : "Shell access is disabled this session.",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface CorrectionContext {
  /** Every tool attached to this conversation, by name. */
  tools?: string[];
  /** 1 for the first correction of this turn, 2 for the next. */
  attempt?: number;
  /** The model claimed the tools were not available to it. */
  denial?: boolean;
}

/**
 * Sent when a reply parsed as neither a tool call nor a plausible final
 * answer — the model narrated running a command it never called, or said it
 * had no tools to call.
 *
 * The denial case needed its own answer. Repeating the syntax at a model
 * that has just said the tool namespace is not exposed to it argues with a
 * claim it did not make: it is not confused about the format, it is looking
 * for a function-calling menu, not finding one, and concluding the tools are
 * gone. Two sessions in the field deadlocked exactly there and both were
 * broken by the same thing — the user asking it to list the tools. It read
 * the roster out of the prompt it already had, and started calling them on
 * the very next turn.
 *
 * So the roster goes in the correction. Naming the tools is evidence against
 * the claim; the syntax alone is not.
 */
export function protocolCorrection(reason: string, ctx: CorrectionContext = {}): string {
  const lines = ["[OnFlip protocol error]", reason, ""];

  if (ctx.denial && ctx.tools?.length) {
    lines.push(
      "These are the tools attached to this conversation, by name:",
      "",
      ctx.tools.join(", "),
      "",
      "They are not a menu you have to be granted, and they will not appear among your own function-calling tools, because they are not that kind of tool. They are this conversation's protocol: the block you type IS the call, and OnFlip on the user's machine runs it and sends the result back. Nothing else has to happen first.",
      ""
    );
  }

  // The second correction of a turn is the last one, so it stops explaining
  // and asks for the smallest call there is. A single harmless call settles
  // the question the model keeps asking itself, and its result is proof.
  if (ctx.denial && (ctx.attempt ?? 1) >= 2) {
    lines.push(
      "Emit exactly this and nothing else, so the point is settled:",
      "",
      "```onflip",
      "tool: list",
      "path: .",
      "```",
      "",
      "The result will come back in this conversation. Then carry on with the task."
    );
    return lines.join("\n");
  }

  lines.push(
    "Reply again using the block form exactly:",
    "",
    "```onflip",
    "tool: <name>",
    "<argument>: <single-line value>",
    "<argument>: |",
    "  <multi-line value, indented two spaces, taken literally>",
    "```",
    "",
    "Escape nothing — quotes, backslashes, `$_` and newlines are all safe inside a `|` block, and that is the whole point of it. Or, if no tool is needed, give your final answer as prose.",
    "Do not describe output you have not received from a tool result."
  );
  return lines.join("\n");
}
/** Instruction used to compact a long conversation into a carry-forward brief. */
/**
 * Ask for a handover brief — a short one.
 *
 * The length limit is the whole point, and it used to be missing. Asked for a
 * thorough brief with no ceiling, the model wrote one: measured across seven
 * consecutive compactions, every summary came back between 27k and 29k
 * characters against a 28k budget. Compaction therefore ended exactly where it
 * started, the next tool call re-triggered it, and the session spent eight
 * minutes summarising itself instead of working.
 *
 * A brief that does not fit is not a brief.
 */
export function compactInstruction(targetChars: number): string {
  const words = Math.max(150, Math.round(targetChars / 6));
  return [
    "[OnFlip] Summarise this session so it can continue in a fresh conversation with no history.",
    "",
    `Hard limit: at most ${targetChars} characters (roughly ${words} words). A brief that exceeds this is useless — it leaves no room for the work that follows. Prefer terse notes to prose, and drop anything cheap to rediscover.`,
    "",
    "Write it as a handover brief covering:",
    "1. What the user asked for, including anything they corrected or clarified.",
    "2. What you have already done — files created or changed, commands run, and what their results were.",
    "3. What you learned about the codebase that would be expensive to rediscover.",
    "4. What is still outstanding, and the exact next step.",
    "",
    "Be specific but compact: real file paths and names, not transcripts. Never paste command output, file contents or HTML into the brief — describe the finding in a line instead. Do not include this instruction in your reply, and do not call any tool — reply with the brief itself.",
  ].join("\n");
}

/** The default shape, for callers with no budget of their own. */
export const COMPACT_INSTRUCTION = compactInstruction(6_000);
