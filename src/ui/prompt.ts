import chalk from "chalk";
import * as fs from "node:fs";
import { theme } from "./theme";
import { termWidth, truncate, wrap, isInteractive, erase, cursor } from "./ansi";
import { highlightLine } from "./markdown";
import { renderTextDiff, formatStats } from "./diff";
import { captureKeys, Key, supportsRaw } from "./keys";
import { PermissionRequest, PermissionDecision } from "../types";

const GUTTER = "  ";

function out(s: string): void {
  process.stdout.write(s);
}

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
  /** Single key that selects this option directly. */
  key?: string;
  danger?: boolean;
}

/**
 * Line-mode selector for terminals that cannot do raw input. Prints a numbered
 * list and reads one line. Falls back to the caller's default only when stdin
 * closes without an answer.
 */
async function selectByNumber<T>(
  question: string,
  choices: Choice<T>[],
  opts?: { fallback?: T }
): Promise<T> {
  const t = theme();
  out(`\n${GUTTER}${chalk.hex(t.text).bold(question)}\n`);
  choices.forEach((c, i) => {
    const hint = c.hint ? chalk.hex(t.border)(`  ${c.hint}`) : "";
    out(`${GUTTER}  ${chalk.hex(t.accent)(String(i + 1))}. ${chalk.hex(t.text)(c.label)}${hint}\n`);
  });
  out(`${GUTTER}${chalk.hex(t.muted)(`Enter 1-${choices.length}: `)}`);

  if (!process.stdin.readable) {
    out("\n");
    return opts && "fallback" in opts ? (opts.fallback as T) : choices[choices.length - 1].value;
  }

  const answer = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      process.stdin.removeListener("data", onData);
      resolve(String(chunk).trim());
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });

  const index = Number(answer) - 1;
  if (Number.isInteger(index) && index >= 0 && index < choices.length) {
    return choices[index].value;
  }
  // An unparseable answer is treated as "no", which callers order last.
  return opts && "fallback" in opts ? (opts.fallback as T) : choices[choices.length - 1].value;
}

/**
 * Arrow-key selector. Falls back to a numbered prompt when the terminal cannot
 * do raw mode (piped input, CI), and to the first choice when there is no TTY
 * at all — a non-interactive run must not block forever on a question.
 */
export async function select<T>(
  question: string,
  choices: Choice<T>[],
  opts?: { fallback?: T }
): Promise<T> {
  const t = theme();

  // No raw keyboard: fall back to a numbered prompt read as a whole line,
  // rather than silently answering on the user's behalf.
  if (!isInteractive() || !supportsRaw()) {
    return selectByNumber(question, choices, opts);
  }

  let index = 0;
  let drawnLines = 0;

  const draw = () => {
    if (drawnLines > 0) {
      out(cursor.up(drawnLines));
      out(erase.down);
    }
    let lines = 0;
    out(`${GUTTER}${chalk.hex(t.text).bold(question)}\n`);
    lines++;
    choices.forEach((c, i) => {
      const active = i === index;
      const marker = active ? chalk.hex(t.accent)("❯") : " ";
      const keyHint = c.key ? chalk.hex(t.border)(`${c.key}`) : " ";
      const colour = c.danger ? t.error : active ? t.text : t.muted;
      const label = active ? chalk.hex(colour).bold(c.label) : chalk.hex(colour)(c.label);
      const hint = c.hint ? chalk.hex(t.border)(`  ${c.hint}`) : "";
      out(`${GUTTER}${marker} ${keyHint} ${label}${hint}\n`);
      lines++;
    });
    drawnLines = lines;
  };

  draw();

  return new Promise<T>((resolve) => {
    const release = captureKeys((key: Key) => {
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        index = (index - 1 + choices.length) % choices.length;
        draw();
        return;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab") {
        index = (index + 1) % choices.length;
        draw();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        release();
        out(cursor.up(drawnLines));
        out(erase.down);
        resolve(choices[index].value);
        return;
      }
      // Escape and ctrl+c both mean "no" — resolve to the last choice, which
      // callers order as the safe/decline option.
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        release();
        out(cursor.up(drawnLines));
        out(erase.down);
        resolve(choices[choices.length - 1].value);
        return;
      }
      const typed = key.sequence?.toLowerCase();
      const direct = choices.findIndex((c) => c.key && c.key.toLowerCase() === typed);
      if (direct !== -1) {
        release();
        out(cursor.up(drawnLines));
        out(erase.down);
        resolve(choices[direct].value);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// permission prompt
// ---------------------------------------------------------------------------

type Answer = "once" | "always" | "no" | "abort";

export interface PermissionPromptOptions {
  /** Why the policy is asking, shown as a subtitle. */
  reason: string;
  dangerous: boolean;
  /** New content for a write, so the prompt can show a diff. */
  preview?: { path: string; oldText: string; newText: string };
}

/**
 * Show what is about to happen and ask for approval. Returns the user's
 * decision; `abort` means they want the whole turn cancelled.
 */
export async function askPermission(
  req: PermissionRequest,
  opts: PermissionPromptOptions
): Promise<PermissionDecision & { abort?: boolean }> {
  const t = theme();
  const width = termWidth();

  process.stdout.write("\n");
  const heading = opts.dangerous
    ? chalk.hex(t.error).bold("  Approval required")
    : chalk.hex(t.warning).bold("  Approval required");
  out(`${heading}  ${chalk.hex(t.muted)(opts.reason)}\n`);
  out(`${GUTTER}${chalk.hex(t.border)("─".repeat(Math.min(width - 4, 78)))}\n`);

  // ---- what is being asked ------------------------------------------------
  if (req.kind === "command") {
    for (const line of wrap(req.subject, width - 8)) {
      out(`${GUTTER}${chalk.hex(t.border)("$")} ${highlightLine(line, "sh")}\n`);
    }
  } else {
    out(`${GUTTER}${chalk.hex(t.secondary)(req.tool)} ${chalk.hex(t.text)(req.subject)}\n`);
  }

  for (const d of req.detail ?? []) {
    out(`${GUTTER}${chalk.hex(t.border)("·")} ${chalk.hex(t.muted)(truncate(d, width - 8))}\n`);
  }

  // ---- diff preview for writes -------------------------------------------
  if (opts.preview) {
    const { lines, stats } = renderTextDiff(opts.preview.oldText, opts.preview.newText, {
      width: width - 6,
      indent: `${GUTTER}${chalk.hex(t.border)("│")} `,
      context: 2,
      maxLines: 24,
    });
    if (lines.length) {
      out("\n");
      for (const line of lines) out(`${line}\n`);
      out(`${GUTTER}${chalk.hex(t.border)("└")} ${formatStats(stats)}\n`);
    }
  }

  out("\n");

  const rememberLabel =
    req.kind === "command"
      ? `Yes, and don't ask again for "${commandLabel(req.subject)}"`
      : "Yes, and don't ask again for this directory";

  const answer = await select<Answer>("Allow this?", [
    { label: "Yes, once", value: "once", key: "y" },
    { label: rememberLabel, value: "always", key: "a" },
    { label: "No, and tell the agent what to do instead", value: "no", key: "n" },
    { label: "No, stop this turn", value: "abort", key: "esc", danger: true },
  ]);

  switch (answer) {
    case "once":
      return { allow: true };
    case "always":
      return { allow: true, remember: true };
    case "no":
      return { allow: false, reason: "the user declined this action" };
    default:
      return { allow: false, reason: "the user stopped the turn", abort: true };
  }
}

function commandLabel(command: string): string {
  return truncate(command.trim().split(/\s+/).slice(0, 2).join(" "), 30);
}

/** Read the current content of a file for the diff preview, if it exists. */
export function previewFor(req: PermissionRequest, newText?: string): PermissionPromptOptions["preview"] {
  if (req.kind !== "write" || !req.targetPath || typeof newText !== "string") return undefined;
  let oldText = "";
  try {
    oldText = fs.readFileSync(req.targetPath, "utf8");
  } catch {
    oldText = "";
  }
  return { path: req.targetPath, oldText, newText };
}

/** Simple yes/no confirmation used by destructive CLI commands. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  return select<boolean>(
    question,
    defaultYes
      ? [
          { label: "Yes", value: true, key: "y" },
          { label: "No", value: false, key: "n" },
        ]
      : [
          { label: "No", value: false, key: "n" },
          { label: "Yes", value: true, key: "y" },
        ],
    { fallback: false }
  );
}
