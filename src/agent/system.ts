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
      "- NEVER hand the task to ChatGPT Work, Codex, Agent mode or any other ChatGPT product, and never offer to \"continue in Work\". Those run on OpenAI's computers and cannot see this one; a hand-off ends the turn with nothing done. Every step, however many there are, happens here through onflip blocks.",
      "- Write your prose in the language the user writes in (Russian, Uzbek, English or any other). The onflip block never changes with the language: the fence, the `tool:` line, the tool names and the argument keys stay exactly as documented below, and file contents and commands are written exactly as the user's project needs them.",
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
      "- Every reply ends with a block: the tool block(s) for the next step, or one of the two closing blocks described under \"Ending a turn\". A reply with no block is an error and is sent back to you.",
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

  // -- how a turn ends --------------------------------------------------------
  // The turn used to end on any reply without a tool call, and the lighter
  // models ended turns that way constantly: "I'll verify the build now." as
  // the whole reply, and the build never run. Making the end of a turn an
  // explicit block — as every agent framework that has faced this does —
  // turns "is it finished?" from a guess about the prose into a fact the
  // loop can read.
  sections.push(
    [
      "## Ending a turn",
      "",
      "Every reply ends with a block: either the tool block(s) for the next step, or one of these two closing blocks.",
      "",
      "```onflip",
      "tool: done",
      "summary: |",
      "  What was done, with files as path:line, and anything left out and why.",
      "```",
      "",
      "`done` ends the turn with your final answer; `summary` is that answer, in Markdown, as the user should read it. Send it only when the whole request is finished and verified — never after a single step, never while an item on your task list is still open (mark it completed or cancelled first), and never right after a failed tool call.",
      "",
      "```onflip",
      "tool: ask_user",
      "question: |",
      "  Which database should the report read from?",
      "options:",
      "  - the production replica",
      "  - the local SQLite copy",
      "```",
      "",
      "`ask_user` ends the turn with a question only the user can answer — a real choice about what to do, with `options` when there are obvious ones. Never use it to ask permission to run a tool: OnFlip approves tool calls itself, so emit the call instead. Never use it to ask for the tools to be enabled, exposed, reconnected or granted: they are attached to every turn, this one included, and a reply that says otherwise is sent back to you. If you believe a tool is missing, call it and read the result.",
      "",
      "Prose before a block is fine, in the user's language. Prose alone ends nothing: a reply with no block is an error, and OnFlip sends it straight back to you. \"I'll verify the build now\" with no block is a lost turn — the bash block belongs in that same reply.",
    ].join("\n")
  );

  // -- pictures -------------------------------------------------------------
  sections.push(
    [
      "## Pictures",
      "",
      "There is no image tool in the list below, and you do not need one. Drawing an image is the one built-in ability of yours that OnFlip can carry over: it fetches whatever you drew out of the reply and writes it into the working folder, then tells you the filename in the next message. That is why it is not banned along with python and browsing — those report on the wrong computer, whereas a picture is content, and the file ends up on the right one.",
      "",
      "- Asked for a photo, an illustration, a texture or a logo: draw it. The file lands in the folder and OnFlip names it for you.",
      "- Asked for a banner, an icon, a diagram, a chart or a UI mock-up: write SVG or CSS into a file with the `write` tool instead. It is sharp at any size, it is editable afterwards, it costs no image quota, and it belongs in version control. Reach for this first — most \"make me an image\" requests in a project are really this.",
      "- Wait for OnFlip to tell you the filename before referencing it from HTML or CSS. Do not guess a path for a picture you have not been told about, and do not claim to have saved one.",
      "- If image generation is refused or unavailable — it is limited on the free and Go plans — say so plainly in one line and offer the SVG route. Do not retry it.",
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
      "If a result comes back saying the user declined, do not retry it: acknowledge it and ask how they would like to proceed, with an `ask_user` block.",
      shellEnabled
        ? "Shell access is available through the `bash` tool. Use it directly — never ask the user to run a command and paste the output back, and never tell them to open a terminal themselves.\n" +
          "Anything that does not exit on its own — a dev server, a watcher, a tunnel — must be started with `background: true`, which returns a job id immediately; read its output with `job_output` and stop it with `kill_job`. Running one in the foreground blocks the turn until the tool times out and kills it, which looks to the user like the agent hanging. Do not hand-roll this with Start-Job, `&`, or nohup: the tool already does it, and its jobs are the ones OnFlip can show and stop."
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
      "6. **Finish the job.** Do not stop halfway and hand back a plan when you were asked for a change. If part of the task is genuinely blocked, complete everything else and say plainly in the `done` summary what you left out and why.",
      "",
      "Do not commit, push, or otherwise publish anything unless the user explicitly asked for it.",
    ].join("\n")
  );

  // -- answer style ---------------------------------------------------------
  sections.push(
    [
      "## How to reply",
      "",
      "Your final answer is the `summary` of your `done` block (any prose you wrote in front of the block is shown too). It is read in a terminal. Markdown renders, so use it, but keep it tight.",
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
/** A background job as the reminder needs to describe it. */
export interface JobSummary {
  id: string;
  command: string;
  running: boolean;
}

/**
 * The state of this session's background jobs, or "" when there are none.
 *
 * Nothing told the model when a background job died. It learned that a job
 * existed from the tool result that started it, and that result stayed true
 * forever as far as the transcript was concerned — so a dev server that had
 * since exited still looked alive, and compaction copied the belief into the
 * handover brief as settled fact. Live, that cost two turns: a verification
 * step ran against a server that was no longer listening, failed, and the
 * retry guarded on `Get-Process node` — which matched some unrelated node
 * process — so it never restarted the server and failed again the same way.
 *
 * Naming the exited jobs is what breaks that loop. The model cannot deduce it
 * and will not ask.
 */
export function backgroundJobLine(jobs?: JobSummary[]): string {
  if (!jobs?.length) return "";
  const described = jobs
    .map((j) => {
      const command = j.command.replace(/\s+/g, " ").trim();
      const shown = command.length > 60 ? `${command.slice(0, 57)}…` : command;
      return `${j.id} \`${shown}\` — ${j.running ? "running" : "exited"}`;
    })
    .join("; ");
  const dead = jobs.some((j) => !j.running);
  return [
    `Background jobs from this session: ${described}.`,
    "Read a running job's output with `job_output`.",
    dead
      ? "A job listed as exited is gone — its port is not being served any more. Start it again before anything checks it, and do not guess from an earlier result that said it was up."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function turnReminder(
  shellEnabled: boolean,
  tools?: string[],
  jobs?: JobSummary[]
): string {
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
    "To act on the user's machine, emit a fenced ```onflip block: a `tool:` line naming the tool, then its arguments as `key: value` lines, using `key: |` with an indented body for anything multi-line. Escape nothing.",
    // The whole protocol for ending a turn, in three sentences. The
    // lighter models ended turns with "I'm verifying the build now." and no
    // block for as long as prose alone was allowed to end one.
    "Every reply ends with a block. When the whole request is finished and verified, end with `tool: done` and `summary: |` holding your final answer; when only the user can decide what happens next, end with `tool: ask_user` and `question: |`. There is no third way to end a reply: prose with no block is an error and comes back to you.",
    "Never end a reply by announcing what you are about to do (\"I'm verifying the build now\", \"next I'll implement…\") — put the tool block for that step in the same reply. Never send done while an item on your task list is still open, or right after a failed tool call: fix the failure and take the next step.",
    "Write your prose in the language the user writes in. The onflip block itself never changes with the language: the fence, the `tool:` line, the tool names and the argument keys stay exactly as documented.",
    "Do not use your own python/analysis/browsing tools — they run on the wrong machine.",
    // Live: a coding request answered with a "Continue in ChatGPT Work" card
    // — the task handed to ChatGPT's own agent product, which cannot see
    // this machine — and the turn ended with nothing done.
    "Never hand the task to ChatGPT Work, Codex, Agent mode or any other ChatGPT product, and never offer to. They cannot reach this computer; every step happens here, through onflip blocks, however many it takes.",
    "Never invent file contents, directory listings, or command output. If you have not seen it in a tool result, call a tool.",
    shellEnabled ? backgroundJobLine(jobs) : "Shell access is disabled this session.",
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

/** The roster, as evidence against a model that says the tools are missing. */
function rosterLines(tools: string[]): string[] {
  return [
    "These are the tools attached to this conversation, by name:",
    "",
    tools.join(", "),
    "",
    "They are not a menu you have to be granted, and they will not appear among your own function-calling tools, because they are not that kind of tool. They are this conversation's protocol: the block you type IS the call, and OnFlip on the user's machine runs it and sends the result back. Nothing else has to happen first.",
    "",
  ];
}

/**
 * The smallest call there is, demanded verbatim.
 *
 * The second reminder of a turn is the last one, so it stops explaining
 * and asks for one harmless call: its result settles the question the
 * model keeps asking itself, and is proof.
 */
function settleWithListLines(): string[] {
  return [
    "Emit exactly this and nothing else, so the point is settled:",
    "",
    "```onflip",
    "tool: list",
    "path: .",
    "```",
    "",
    "The result will come back in this conversation. Then carry on with the task.",
  ];
}

/**
 * Sent when a reply tried to call a tool and the call could not be parsed.
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

  if (ctx.denial && ctx.tools?.length) lines.push(...rosterLines(ctx.tools));

  if (ctx.denial && (ctx.attempt ?? 1) >= 2) {
    lines.push(...settleWithListLines());
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
    "Escape nothing — quotes, backslashes, `$_` and newlines are all safe inside a `|` block, and that is the whole point of it. Or end the turn with `tool: done` (`summary: |`) or `tool: ask_user` (`question: |`), as documented.",
    "Do not describe output you have not received from a tool result."
  );
  return lines.join("\n");
}

/**
 * What a block-less reply looked like, when the loop could tell.
 *
 * Hints, never verdicts: the loop nudges every block-less reply the same
 * number of times whatever the words said. The variant only picks the
 * paragraph that answers the model's particular misunderstanding.
 */
export type SlipVariant = "handoff" | "denial" | "permission" | "fabrication" | "cut";

export interface NudgeContext {
  /** Every tool attached to this conversation, by name. */
  tools: string[];
  /** 1 for the first nudge since the model last acted, 2 for the last. */
  attempt: number;
  variant: SlipVariant | null;
  /** The open task-list items, one line each. */
  openTodos: string[];
  openCount: number;
  /** Set when the reply did end with a closing block, but its text was a refusal. */
  closing?: "done" | "ask_user";
}

const AUTOMATED = "[OnFlip protocol error — automated message; do not answer it conversationally]";

/** The three ways a reply may end, as the nudges state them. */
const THREE_WAYS = [
  "Every reply must end with a block. There are exactly three ways to end one:",
  "1. The tool block(s) for the next step — to keep working.",
  "2. A `done` block with `summary: |` — when the whole request is finished and verified.",
  "3. An `ask_user` block with `question: |` — when only the user can decide what happens next.",
];

/**
 * Sent back for a reply that carried no block at all.
 *
 * Modelled on Cline's automated "you did not use a tool" message, which is
 * what every framework that drives a chat model as an agent converged on:
 * the model is told, mechanically, that the reply ended nothing, reminded of
 * the ways it can end one, and asked for the block alone. The paragraph in
 * the middle answers whichever misunderstanding the words suggested.
 */
export function noBlockNudge(ctx: NudgeContext): string {
  const opening =
    ctx.closing === "ask_user"
      ? "Your last reply ended the turn with an `ask_user` block, but what it asked is not a question the user can answer: the tools are OnFlip's to run and they are attached to this conversation on every turn, this one included. `ask_user` is for a real choice about the work — never for tool access, permission or a go-ahead."
      : ctx.closing === "done"
        ? "Your last reply ended the turn with a `done` block whose summary says the work could not be done for want of the tools. `done` means the request is finished; a turn that could not act is not finished, and the tools are attached on every turn, this one included."
        : "Your last reply had no onflip block, so nothing ran and the turn would have ended there with the work unfinished.";
  const lines = [AUTOMATED, opening, "", ...THREE_WAYS, ""];

  switch (ctx.variant) {
    case "denial":
      if (ctx.tools.length) lines.push(...rosterLines(ctx.tools));
      if (ctx.attempt >= 2) {
        lines.push(...settleWithListLines());
        return lines.join("\n");
      }
      break;
    case "permission":
      lines.push(
        "You asked for permission. OnFlip approves tool calls itself and never needs asking: emit the call and it either runs or comes back declined. Use `ask_user` only for a genuine choice about what to do, never for a go-ahead.",
        ""
      );
      break;
    case "fabrication":
      lines.push(
        "You described running or reading something, but no tool ran — whatever output you reported is invented. Call the tool and wait for the real result.",
        ""
      );
      break;
    case "handoff":
      lines.push(
        "You handed the task to ChatGPT Work (or another ChatGPT product). It runs on a different computer and cannot see this one; nothing was done. Everything happens here, through onflip blocks, one step at a time — emit the first one now.",
        ""
      );
      break;
    case "cut":
      lines.push("Your reply looks cut off. Send it again, complete, block included.", "");
      break;
    default:
      lines.push(
        "If you were about to do something, do it: the tool block for that step goes in this reply, not a description of it. If that reply was your final answer, send it again as a `done` block.",
        ""
      );
  }

  if (ctx.openCount > 0) {
    lines.push(
      `Your task list still has ${ctx.openCount} open item${ctx.openCount === 1 ? "" : "s"}:`,
      ...ctx.openTodos,
      "Continue with the next one now, or — if the remaining items are done or no longer needed — mark them completed or cancelled with todo_write before sending done.",
      ""
    );
  }

  lines.push(
    "The text of your previous reply is kept and will be shown to the user — do not repeat it. Reply now with just the block that applies.",
    `(reminder ${ctx.attempt} of 2)`
  );
  return lines.join("\n");
}

/**
 * Sent once for a `done` that arrived with the model's own task list still
 * open — the one shape of stopping short the protocol can see without
 * reading a word. A second `done` is accepted: the list may simply be stale.
 */
export function doneWithOpenTodosNudge(ctx: { openTodos: string[]; openCount: number }): string {
  return [
    AUTOMATED,
    `You sent \`done\`, but your task list still has ${ctx.openCount} open item${ctx.openCount === 1 ? "" : "s"}:`,
    ...ctx.openTodos,
    "",
    "`done` means the whole request is finished. Either continue with the next open item now — emit its tool block — or, if the remaining items are done or no longer needed, mark them completed or cancelled with todo_write and then send done again.",
    "If you send done again with items still open, the turn ends as it is and the user is told which items were left.",
  ].join("\n");
}

/**
 * Sent when ChatGPT itself reported the reply cut off at its length limit
 * and its own "Continue generating" could not be used. Nothing in a cut-off
 * reply is safe to run: a `write` that stopped halfway would leave half a
 * file on disk.
 */
export function truncationNudge(ctx: { attempt: number }): string {
  return [
    AUTOMATED,
    "ChatGPT reported that your last reply was cut off at its length limit, so nothing in it was run.",
    "Send it again, complete. If it carried a large file, write the file in smaller pieces instead — `write` the first part, then `edit` to append the rest — each in its own reply, and keep every reply well under the length limit.",
    `(attempt ${ctx.attempt} of 2)`,
  ].join("\n");
}

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
    "Be specific but compact: real file paths and names, not transcripts. Never paste command output, file contents or HTML into the brief — describe the finding in a line instead. Do not include this instruction in your reply, and do not call any tool — reply with the brief itself, as plain prose with no onflip block.",
  ].join("\n");
}

/** The default shape, for callers with no budget of their own. */
export const COMPACT_INSTRUCTION = compactInstruction(6_000);
