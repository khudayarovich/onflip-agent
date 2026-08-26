import chalk from "chalk";
import * as path from "node:path";
import { ToolCall, ToolResult, TodoItem } from "../types";
import { theme } from "./theme";
import { termWidth, displayWidth, truncate, padEnd, wrap, isInteractive, cursor, erase } from "./ansi";
import { renderMarkdown, renderInline, highlightLine } from "./markdown";
import { renderTextDiff, formatStats } from "./diff";
import * as screen from "./screen";

/**
 * Terminal presentation layer. Everything the user sees is composed here so
 * the agent loop stays free of formatting concerns.
 */

const GUTTER = "  ";

/**
 * All rendered output funnels through here so full-screen mode can capture it.
 * In the alternate buffer there is no scrollback to append to — the transcript
 * is kept in memory and drawn as a viewport instead.
 */
/**
 * The composer, when one is on screen in inline mode.
 *
 * Full-screen repaints the whole frame, so it needs nothing here. Inline mode
 * writes straight to the terminal, so the composer has to be lifted out of the
 * way before output lands and put back afterwards — otherwise it would either
 * be scribbled over or have to be torn down for the whole turn.
 */
export interface ComposerHook {
  clear(): void;
  redraw(): void;
  /** Transient line drawn just above the box — the spinner lives here. */
  setStatus(line: string | null): void;
}

let composer: ComposerHook | null = null;
let redrawScheduled = false;

export function attachComposer(hook: ComposerHook | null): void {
  composer = hook;
  redrawScheduled = false;
}

function out(s: string): void {
  if (screen.isActive()) {
    screen.write(s);
    return;
  }
  if (composer) {
    composer.clear();
    process.stdout.write(s);
    // Redraw once per tick rather than per write: a single rendered message
    // calls out() many times and repainting each one flickers.
    if (!redrawScheduled) {
      redrawScheduled = true;
      setImmediate(() => {
        redrawScheduled = false;
        composer?.redraw();
      });
    }
    return;
  }
  process.stdout.write(s);
}

export function blank(): void {
  out("\n");
}

/**
 * Write already-rendered text through the same funnel as everything else.
 *
 * Exported for the modal prompts. They compose their own blocks, but writing
 * those straight to stdout puts them behind the back of whichever component
 * owns the screen — which is how the approval prompt ended up being erased by
 * the next frame in full-screen mode.
 */
export function emit(text: string): void {
  out(text);
}

/**
 * Lift the inline composer out of the way for a prompt drawn at the cursor,
 * and put it back when the returned function runs.
 *
 * Detaching rather than merely clearing is the point: `out()` schedules a
 * redraw of its own, which would otherwise repaint the box underneath the
 * prompt half a tick later. Full-screen paints the composer as part of the
 * frame and has nothing to move, so this is a no-op there.
 */
export function pauseComposer(): () => void {
  const hook = composer;
  if (!hook || screen.isActive()) return () => {};
  composer = null;
  redrawScheduled = false;
  hook.clear();
  return () => {
    composer = hook;
    hook.redraw();
  };
}

// ---------------------------------------------------------------------------
// banner
// ---------------------------------------------------------------------------

const LOGO = [
  "▄▀▄ █▄ █ █▀ █   █ █▀▄",
  "▀▄▀ █ ▀█ █▀ █▄▄ █ █▀ ",
];

export interface BannerInfo {
  version: string;
  model: string;
  cwd: string;
  approval: string;
  transport: string;
  sessionId?: string;
  instructionSources?: string[];
}

/**
 * The strip pinned to the top of the screen in full-screen mode.
 *
 * Kept to two rows on purpose. The full banner is worth reading once and then
 * scrolling past; what is worth having permanently is the brand, and the two
 * facts that change what a keystroke will do — which model is answering and
 * how much it is allowed to do without asking.
 */
export function headerLines(info: BannerInfo): string[] {
  const t = theme();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const shortCwd = home && info.cwd.startsWith(home) ? `~${info.cwd.slice(home.length)}` : info.cwd;
  const width = termWidth();

  // The wordmark itself, not the word — it is the thing that says at a
  // glance which tool you are looking at, and it is two rows tall, so the
  // facts sit beside it rather than under it.
  const facts = [`v${info.version}`, info.model, info.approval].filter(Boolean);
  const detail = [facts.join(" · "), shortCwd.replace(/\\/g, "/")];

  const logoWidth = Math.max(...LOGO.map((l) => displayWidth(l)));
  const room = Math.max(0, width - GUTTER.length - logoWidth - 4);

  const rows = LOGO.map((line, i) => {
    const mark = chalk.hex(t.accent).bold(padEnd(line, logoWidth));
    if (room < 12) return `${GUTTER}${mark}`;
    const text = truncate(detail[i] ?? "", room);
    const tint = i === 0 ? t.muted : t.border;
    return `${GUTTER}${mark}   ${chalk.hex(tint)(text)}`;
  });

  // A rule under it, so the pinned band reads as a band rather than as the
  // first two lines of the transcript.
  rows.push(chalk.hex(t.border)("─".repeat(Math.max(0, width))));
  return rows;
}

export function banner(info: BannerInfo): void {
  const t = theme();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const shortCwd = home && info.cwd.startsWith(home) ? `~${info.cwd.slice(home.length)}` : info.cwd;

  // In full-screen the wordmark and the working settings are already pinned
  // above, so printing them again just puts the brand on screen twice. What
  // is left is the part the header has no room for.
  const pinned = screen.isActive();

  blank();
  if (!pinned) {
    for (const line of LOGO) {
      out(`${GUTTER}${chalk.hex(t.accent).bold(line)}\n`);
    }
    out(
      `${GUTTER}${chalk.hex(t.muted)(`v${info.version}`)}  ${chalk.hex(t.border)("·")}  ${chalk.hex(t.muted)(
        "autonomous agent on your ChatGPT web session"
      )}\n`
    );
    blank();
  }

  const rows: [string, string][] = [];
  if (!pinned) {
    rows.push(["cwd", shortCwd.replace(/\\/g, "/")]);
    rows.push(["model", info.model]);
    rows.push(["approval", info.approval]);
  }
  rows.push(["transport", info.transport]);
  if (info.sessionId) rows.push(["session", info.sessionId]);
  if (info.instructionSources?.length) {
    rows.push([
      "context",
      info.instructionSources.map((f) => path.basename(f)).join(", "),
    ]);
  }

  for (const [label, value] of rows) {
    out(`${GUTTER}${chalk.hex(t.muted)(label.padEnd(10))}${chalk.hex(t.text)(value)}\n`);
  }
  blank();
  out(
    `${GUTTER}${chalk.hex(t.muted)("/help for commands  ·  ctrl+c to interrupt  ·  ctrl+d to exit")}\n`
  );
  blank();
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export function userMessage(text: string): void {
  const t = theme();
  const width = termWidth() - 6;
  blank();
  for (const line of wrap(text.trim(), width)) {
    out(`${GUTTER}${chalk.hex(t.accent)("▌")} ${chalk.hex(t.text).bold(line)}\n`);
  }
  blank();
}

export function assistantMessage(text: string): void {
  if (!text.trim()) return;
  const lines = renderMarkdown(text, { width: termWidth() - 4, indent: GUTTER });
  for (const line of lines) out(`${line}\n`);
  blank();
}

/** Short prose the model emitted before a tool call. */
export function narration(text: string): void {
  const t = theme();
  const width = termWidth() - 6;
  for (const line of wrap(text.trim(), width)) {
    out(`${GUTTER}${chalk.hex(t.muted)(renderInline(line))}\n`);
  }
}

/**
 * One status line, wrapped to the terminal and hanging-indented under its
 * marker. Everything here wraps: these messages carry model names, paths and
 * command text, and breaking those mid-word is exactly when they matter most.
 */
function marked(marker: string, markerColour: string, textColour: string, text: string): void {
  const width = termWidth() - displayWidth(GUTTER) - (marker ? 2 : 0);
  const lines = wrap(text.trim(), Math.max(20, width));
  const indent = marker ? "  " : "";
  lines.forEach((line, i) => {
    const prefix = i === 0 && marker ? `${chalk.hex(markerColour)(marker)} ` : indent;
    out(`${GUTTER}${prefix}${chalk.hex(textColour)(line)}\n`);
  });
}

export function notice(text: string): void {
  const t = theme();
  marked("!", t.warning, t.muted, text);
}

export function info(text: string): void {
  const t = theme();
  marked("", t.muted, t.muted, text);
}

export function success(text: string): void {
  const t = theme();
  marked("✔", t.success, t.text, text);
}

export function error(text: string): void {
  const t = theme();
  const width = termWidth() - 6;
  blank();
  const lines = wrap(text, width);
  out(`${GUTTER}${chalk.hex(t.error)("✖")} ${chalk.hex(t.error)(lines[0] ?? "")}\n`);
  for (const line of lines.slice(1)) {
    out(`${GUTTER}  ${chalk.hex(t.muted)(line)}\n`);
  }
  blank();
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  multi_edit: "edit",
  list: "list",
  glob: "glob",
  grep: "grep",
  bash: "bash",
  job_output: "job",
  todo_write: "plan",
  todo_read: "plan",
  web_fetch: "fetch",
};

/** One-line summary of a call's arguments, for the header line. */
function callSubject(call: ToolCall): string {
  const a = call.arguments ?? {};
  switch (call.tool) {
    case "bash":
      return String(a.command ?? "");
    case "read":
    case "write":
    case "edit":
    case "multi_edit":
    case "list":
      return String(a.path ?? ".");
    case "glob":
      return String(a.pattern ?? "");
    case "grep":
      return `${String(a.pattern ?? "")}${a.include ? ` in ${a.include}` : ""}`;
    case "web_fetch":
      return String(a.url ?? "");
    case "todo_write":
      return "update task list";
    case "todo_read":
      return "read task list";
    case "job_output":
      return String(a.id ?? "");
    default: {
      const json = JSON.stringify(a);
      return json === "{}" ? "" : json;
    }
  }
}

export function toolStart(call: ToolCall): void {
  const t = theme();
  const label = TOOL_LABELS[call.tool] ?? call.tool;
  const subject = callSubject(call);
  const width = termWidth();
  const head = `${chalk.hex(t.accent)("▐")} ${chalk.hex(t.secondary).bold(label)}`;
  const budget = width - displayWidth(label) - 8;
  out(`${GUTTER}${head}  ${chalk.hex(t.text)(truncate(subject.replace(/\s+/g, " "), budget))}\n`);
}

export function toolEnd(_call: ToolCall, result: ToolResult): void {
  const t = theme();
  const width = termWidth();
  const bar = chalk.hex(t.border)("│");

  if (result.denied) {
    out(`${GUTTER}${chalk.hex(t.border)("└")} ${chalk.hex(t.warning)("declined")}\n`);
    blank();
    return;
  }

  const display = result.display;

  if (display?.kind === "diff") {
    const { lines, stats } = renderTextDiff(display.oldText, display.newText, {
      width: width - 6,
      indent: `${GUTTER}${bar} `,
      context: 2,
      maxLines: 40,
    });
    for (const line of lines) out(`${line}\n`);
    out(`${GUTTER}${chalk.hex(t.border)("└")} ${formatStats(stats)}\n`);
    blank();
    return;
  }

  if (display?.kind === "todos") {
    renderTodos(display.items, `${GUTTER}${bar} `);
    out(`${GUTTER}${chalk.hex(t.border)("└")} ${chalk.hex(t.muted)(result.title ?? "")}\n`);
    blank();
    return;
  }

  const body =
    display?.kind === "text" && display.lines.length
      ? display.lines
      : result.output.split("\n");

  const maxLines = result.error ? 20 : 12;
  const shown = body.slice(0, maxLines);
  const contentWidth = width - displayWidth(GUTTER) - 4;

  for (const line of shown) {
    const painted =
      display?.kind === "text" && display.lang
        ? highlightLine(line, display.lang)
        : chalk.hex(result.error ? t.error : t.muted)(line);
    out(`${GUTTER}${bar} ${truncate(painted, contentWidth)}\n`);
  }

  const hidden = body.length - shown.length;
  const footer = result.error
    ? chalk.hex(t.error)(result.title ? `failed — ${result.title}` : "failed")
    : chalk.hex(t.muted)(result.title ?? `${body.length} line${body.length === 1 ? "" : "s"}`);
  const more = hidden > 0 ? chalk.hex(t.border)(`  (+${hidden} more)`) : "";
  out(`${GUTTER}${chalk.hex(t.border)("└")} ${footer}${more}\n`);
  blank();
}

export function renderTodos(items: TodoItem[], indent = GUTTER): void {
  const t = theme();
  for (const item of items) {
    let mark: string;
    let text: string;
    switch (item.status) {
      case "completed":
        mark = chalk.hex(t.success)("✔");
        text = chalk.hex(t.muted).strikethrough(item.content);
        break;
      case "in_progress":
        mark = chalk.hex(t.accent)("▸");
        text = chalk.hex(t.text).bold(item.content);
        break;
      case "cancelled":
        mark = chalk.hex(t.border)("✕");
        text = chalk.hex(t.border).strikethrough(item.content);
        break;
      default:
        mark = chalk.hex(t.border)("○");
        text = chalk.hex(t.muted)(item.content);
    }
    out(`${indent}${mark} ${text}\n`);
  }
}

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

/**
 * A single banner-style row, printed when session state changes.
 *
 * The startup banner is scrollback: it cannot update, so after `/model` the
 * most prominent "model" on screen is a stale one. Re-emitting the row in the
 * same shape at the point of the change leaves an accurate record where the
 * user is already looking.
 */
export function stateRow(label: string, value: string): void {
  const t = theme();
  out(
    `${GUTTER}${chalk.hex(t.muted)(label.padEnd(10))}${chalk.hex(t.accent)(value)}\n`
  );
}

export function panel(title: string, rows: { label: string; value: string }[]): void {
  const t = theme();
  const width = Math.min(termWidth() - 4, 78);
  const labelWidth = Math.max(...rows.map((r) => r.label.length), 8) + 2;

  blank();
  out(`${GUTTER}${chalk.hex(t.accent).bold(title)}\n`);
  out(`${GUTTER}${chalk.hex(t.border)("─".repeat(width))}\n`);
  for (const r of rows) {
    out(
      `${GUTTER}${chalk.hex(t.muted)(padEnd(r.label, labelWidth))}${chalk.hex(t.text)(r.value)}\n`
    );
  }
  blank();
}

export function list(title: string, items: string[]): void {
  const t = theme();
  blank();
  out(`${GUTTER}${chalk.hex(t.accent).bold(title)}\n`);
  for (const item of items) {
    out(`${GUTTER}${chalk.hex(t.border)("·")} ${chalk.hex(t.text)(item)}\n`);
  }
  blank();
}

// ---------------------------------------------------------------------------
// spinner
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How long one frame of the spinner is on screen. */
export const SPINNER_INTERVAL_MS = 100;

/**
 * The frame the animation is on right now.
 *
 * Derived from the clock rather than a counter so anything else that wants
 * to show it — the composer's own busy label — turns in step with the
 * spinner instead of beside it at its own pace.
 */
export function spinnerGlyph(): string {
  return FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % FRAMES.length];
}

let spinnerTimer: NodeJS.Timeout | null = null;
let spinnerStart = 0;
let spinnerLabel = "";
let spinnerDetail = "";

export function startSpinner(label: string): void {
  stopSpinner();
  if (!isInteractive()) {
    info(`${label}…`);
    return;
  }
  spinnerLabel = label;
  spinnerDetail = "";
  spinnerStart = Date.now();
  let frame = 0;
  if (!screen.isActive()) process.stdout.write(cursor.hide);
  const draw = () => {
    const t = theme();
    const elapsed = Math.round((Date.now() - spinnerStart) / 1000);

    // The whole line must fit on one row. A wrapped spinner line cannot be
    // erased by the leading \r, so the overflow would smear down the screen.
    const budget = termWidth() - 1 - displayWidth(GUTTER);
    const glyph = spinnerGlyph();
    const head = `${glyph} ${spinnerLabel} ${elapsed}s`;
    const parts = [
      chalk.hex(t.accent)(glyph),
      chalk.hex(t.text)(spinnerLabel),
      chalk.hex(t.border)(`${elapsed}s`),
    ];
    let used = displayWidth(head);

    const hint = elapsed >= 3 ? "· ctrl+c to interrupt" : "";
    const detailRoom = budget - used - (hint ? hint.length + 1 : 0) - 1;
    if (spinnerDetail && detailRoom > 8) {
      const detail = truncate(spinnerDetail, detailRoom);
      parts.push(chalk.hex(t.muted)(detail));
      used += displayWidth(detail) + 1;
    }
    if (hint && used + hint.length + 1 <= budget) {
      parts.push(chalk.hex(t.border)(hint));
    }

    frame++;

    // The spinner is transient status, not transcript. In full-screen it owns
    // its own row above the composer; writing it through `out()` would append
    // a newline-less fragment to the transcript buffer, where it is held as an
    // incomplete line and never drawn — the spinner would simply never appear.
    const line = `${GUTTER}${parts.join(" ")}`;
    if (screen.isActive()) {
      screen.setStatus(line);
      return;
    }
    // With a composer on screen the spinner cannot write at the cursor — that
    // is where the box is. It gets a row of its own just above it.
    if (composer) {
      composer.setStatus(line);
      return;
    }
    process.stdout.write(`\r${erase.line}${line}`);
  };
  draw();
  spinnerTimer = setInterval(draw, SPINNER_INTERVAL_MS);
  spinnerTimer.unref?.();
}

/** Update the trailing detail without restarting the timer. */
export function updateSpinner(detail: string): void {
  spinnerDetail = detail.replace(/\s+/g, " ").trim();
}

export function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  if (screen.isActive()) {
    screen.setStatus(null);
    return;
  }
  if (composer) {
    composer.setStatus(null);
    return;
  }
  process.stdout.write(`\r${erase.line}${cursor.show}`);
}

export function spinnerRunning(): boolean {
  return spinnerTimer !== null;
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export interface CommandDoc {
  name: string;
  args?: string;
  description: string;
}

export function commandHelp(title: string, commands: CommandDoc[]): void {
  const t = theme();
  const left = commands.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""}`);
  const pad = Math.max(...left.map((l) => l.length)) + 3;

  blank();
  out(`${GUTTER}${chalk.hex(t.accent).bold(title)}\n`);
  blank();
  commands.forEach((c, i) => {
    out(
      `${GUTTER}${chalk.hex(t.secondary)(padEnd(left[i], pad))}${chalk.hex(t.muted)(c.description)}\n`
    );
  });
  blank();
}

/** A prompt accepted while a turn was still running. */
export function queued(text: string, position: number): void {
  const t = theme();
  const width = termWidth() - 8;
  out(
    `${GUTTER}${chalk.hex(t.border)("⋯")} ${chalk.hex(t.muted)(`queued #${position}`)} ` +
      `${chalk.hex(t.text)(truncate(text.replace(/\s+/g, " "), width))}\n`
  );
}
