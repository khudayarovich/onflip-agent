import chalk from "chalk";
import { theme } from "./theme";
import { displayWidth, wrap } from "./ansi";

/**
 * Minimal terminal Markdown renderer. Covers what a coding agent actually
 * emits: headings, lists, fenced code, inline code, emphasis, links, rules,
 * blockquotes and pipe tables. Anything else falls through as plain text.
 */

const SENTINEL = String.fromCharCode(0);

const KEYWORDS: Record<string, string[]> = {
  ts: [
    "const", "let", "var", "function", "return", "if", "else", "for", "while", "class",
    "interface", "type", "import", "export", "from", "async", "await", "new", "extends",
    "implements", "try", "catch", "finally", "throw", "switch", "case", "break", "continue",
    "default", "typeof", "instanceof", "in", "of", "this", "super", "static", "public",
    "private", "protected", "readonly", "enum", "namespace", "declare", "as", "void",
    "null", "undefined", "true", "false", "yield", "delete",
  ],
  py: [
    "def", "class", "return", "if", "elif", "else", "for", "while", "import", "from",
    "as", "try", "except", "finally", "raise", "with", "lambda", "yield", "async",
    "await", "pass", "break", "continue", "global", "nonlocal", "assert", "del",
    "True", "False", "None", "and", "or", "not", "in", "is", "self",
  ],
  sh: [
    "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
    "function", "return", "export", "local", "echo", "cd", "set", "source", "exit",
    "npm", "npx", "node", "git", "cat", "ls", "grep", "find", "sed", "awk", "mkdir", "rm",
  ],
  ps: [
    "if", "else", "elseif", "foreach", "for", "while", "function", "return", "param",
    "try", "catch", "finally", "throw", "switch", "begin", "process", "end", "filter",
  ],
  go: [
    "func", "package", "import", "return", "if", "else", "for", "range", "var", "const",
    "type", "struct", "interface", "map", "chan", "go", "defer", "select", "switch",
    "case", "default", "break", "continue", "nil", "true", "false",
  ],
  rs: [
    "fn", "let", "mut", "const", "struct", "enum", "impl", "trait", "pub", "use", "mod",
    "match", "if", "else", "for", "while", "loop", "return", "self", "Self", "where",
    "async", "await", "move", "ref", "dyn", "crate", "super", "true", "false",
  ],
};

const LANG_ALIASES: Record<string, keyof typeof KEYWORDS> = {
  js: "ts", jsx: "ts", ts: "ts", tsx: "ts", javascript: "ts", typescript: "ts",
  json: "ts", java: "ts", c: "ts", cpp: "ts", "c++": "ts", cs: "ts", csharp: "ts",
  php: "ts", swift: "ts", kotlin: "ts", scala: "ts",
  py: "py", python: "py",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
  ps: "ps", ps1: "ps", powershell: "ps", pwsh: "ps",
  go: "go", golang: "go",
  rs: "rs", rust: "rs",
};

const COMMENT_PREFIX: Record<string, string[]> = {
  ts: ["//"], py: ["#"], sh: ["#"], ps: ["#"], go: ["//"], rs: ["//"],
};

/** Colourise one source line for the given language, best-effort. */
export function highlightLine(line: string, lang?: string): string {
  const t = theme();
  const key = lang ? LANG_ALIASES[lang.toLowerCase()] : undefined;
  if (!key) return chalk.hex(t.text)(line);

  const comments = COMMENT_PREFIX[key] ?? [];
  for (const prefix of comments) {
    const idx = indexOfOutsideString(line, prefix);
    if (idx !== -1) {
      return (
        highlightLine(line.slice(0, idx), lang) + chalk.hex(t.muted)(line.slice(idx))
      );
    }
  }

  const words = new Set(KEYWORDS[key]);
  let out = "";
  // Tokenise into strings / identifiers / numbers / everything else.
  const tokenRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*|\s+|.)/g;
  const matches = line.match(tokenRe);
  if (!matches) return chalk.hex(t.text)(line);
  for (const tok of matches) {
    const first = tok[0];
    if (first === '"' || first === "'" || first === "`") {
      out += chalk.hex(t.success)(tok);
    } else if (/^\d/.test(tok)) {
      out += chalk.hex(t.warning)(tok);
    } else if (words.has(tok)) {
      out += chalk.hex(t.secondary)(tok);
    } else if (/^[A-Za-z_$]/.test(tok)) {
      out += chalk.hex(t.text)(tok);
    } else {
      out += chalk.hex(t.muted)(tok);
    }
  }
  return out;
}

function indexOfOutsideString(line: string, needle: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (line.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Render inline spans: `code`, **bold**, *italic*, ~~strike~~, [text](url). */
export function renderInline(text: string): string {
  const t = theme();
  let out = text;

  // Links first, so their label can still be styled by later passes.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    chalk.hex(t.secondary).underline(label) + chalk.hex(t.muted)(` (${url})`)
  );

  // Inline code is parked behind a NUL sentinel so the emphasis passes below
  // cannot reach inside it — `a*b*c` must stay literal.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(chalk.hex(t.accent)(code));
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`;
  });

  out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, (_m, s: string) => chalk.bold.italic(s));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, s: string) => chalk.bold(s));
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_m, s: string) => chalk.italic(s));
  out = out.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_m, s: string) => chalk.italic(s));
  out = out.replace(/~~([^~\n]+)~~/g, (_m, s: string) => chalk.strikethrough(s));

  const restore = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");
  out = out.replace(restore, (_m, i: string) => codeSpans[Number(i)]);
  return out;
}

export interface MarkdownOptions {
  /** Total columns available for the rendered block. */
  width: number;
  /** Prefix applied to every emitted line (used for the assistant gutter). */
  indent?: string;
}

/** Render a Markdown document to an array of terminal lines. */
export function renderMarkdown(src: string, opts: MarkdownOptions): string[] {
  const t = theme();
  const indent = opts.indent ?? "";
  const width = Math.max(20, opts.width - displayWidth(indent));
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  // Blank spacers stay truly blank; indenting them leaves trailing whitespace
  // that shows up when the transcript is copied out of the terminal.
  const push = (s: string) => out.push(s ? indent + s : "");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code block -------------------------------------------------
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const lang = fence[2] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      renderCodeBlock(body, lang, width).forEach(push);
      continue;
    }

    // ---- horizontal rule ---------------------------------------------------
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      push(chalk.hex(t.border)("─".repeat(width)));
      i++;
      continue;
    }

    // ---- heading -----------------------------------------------------------
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2].trim());
      if (level === 1) {
        push(chalk.hex(t.accent).bold(`▌ ${content}`));
      } else if (level === 2) {
        push(chalk.hex(t.accent).bold(content));
      } else {
        push(chalk.hex(t.secondary).bold(content));
      }
      i++;
      continue;
    }

    // ---- table -------------------------------------------------------------
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          rows.push(splitTableRow(lines[i]));
        }
        i++;
      }
      renderTable(rows, width).forEach(push);
      continue;
    }

    // ---- blockquote --------------------------------------------------------
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      for (const q of wrap(quoted.join("\n"), width - 2)) {
        push(chalk.hex(t.border)("│ ") + chalk.hex(t.muted)(renderInline(q)));
      }
      continue;
    }

    // ---- list item ---------------------------------------------------------
    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const m = (bullet ?? ordered)!;
      const lead = m[1];
      const marker = bullet ? "•" : `${m[2]}.`;
      const rest = m[3];
      const prefix = `${lead}${marker} `;
      const wrapped = wrap(rest, width - displayWidth(prefix));
      const checkbox = rest.match(/^\[([ xX])\]\s*(.*)$/);
      if (checkbox) {
        const done = checkbox[1].toLowerCase() === "x";
        const mark = done ? chalk.hex(t.success)("✔") : chalk.hex(t.muted)("○");
        const label = done
          ? chalk.hex(t.muted).strikethrough(checkbox[2])
          : renderInline(checkbox[2]);
        push(`${lead}${mark} ${label}`);
      } else {
        wrapped.forEach((w, idx) => {
          push(
            idx === 0
              ? chalk.hex(t.accent)(prefix) + renderInline(w)
              : " ".repeat(displayWidth(prefix)) + renderInline(w)
          );
        });
      }
      i++;
      continue;
    }

    // ---- blank -------------------------------------------------------------
    if (!line.trim()) {
      // Collapse runs of blank lines to a single spacer.
      if (out.length && out[out.length - 1].trim() !== "") push("");
      i++;
      continue;
    }

    // ---- paragraph ---------------------------------------------------------
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    for (const w of wrap(para.join(" ").replace(/\s+/g, " "), width)) {
      push(chalk.hex(t.text)(renderInline(w)));
    }
  }

  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function renderCodeBlock(body: string[], lang: string | undefined, width: number): string[] {
  const t = theme();
  const out: string[] = [];
  const bar = chalk.hex(t.border)("│");
  const header = lang ? chalk.hex(t.muted)(` ${lang}`) : "";
  out.push(chalk.hex(t.border)("┌─") + header);
  const gutterWidth = String(body.length).length;
  body.forEach((raw, idx) => {
    const num = chalk.hex(t.border)(String(idx + 1).padStart(gutterWidth));
    for (const seg of hardWrap(raw.replace(/\t/g, "  "), width - gutterWidth - 4)) {
      out.push(`${bar} ${num} ${highlightLine(seg, lang)}`);
    }
  });
  out.push(chalk.hex(t.border)("└─"));
  return out;
}

function hardWrap(s: string, w: number): string[] {
  if (w <= 0) return [s];
  if (displayWidth(s) <= w) return [s];
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (displayWidth(cur + ch) > w) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function renderTable(rows: string[][], width: number): string[] {
  const t = theme();
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(3, ...rows.map((r) => displayWidth(r[c] ?? "")));
  }
  // Shrink proportionally if the table overflows the terminal.
  const total = widths.reduce((a, b) => a + b + 3, 1);
  if (total > width) {
    const scale = (width - cols * 3 - 1) / widths.reduce((a, b) => a + b, 0);
    for (let c = 0; c < cols; c++) widths[c] = Math.max(3, Math.floor(widths[c] * scale));
  }

  const out: string[] = [];
  const line = (l: string, mid: string, r: string) =>
    chalk.hex(t.border)(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r);
  const row = (cells: string[], bold: boolean) =>
    chalk.hex(t.border)("│") +
    widths
      .map((w, c) => {
        const raw = (cells[c] ?? "").slice(0, w);
        const padded = raw + " ".repeat(Math.max(0, w - displayWidth(raw)));
        const styled = bold ? chalk.bold(padded) : renderInline(padded);
        return ` ${styled} `;
      })
      .join(chalk.hex(t.border)("│")) +
    chalk.hex(t.border)("│");

  out.push(line("┌", "┬", "┐"));
  out.push(row(rows[0], true));
  out.push(line("├", "┼", "┤"));
  for (const r of rows.slice(1)) out.push(row(r, false));
  out.push(line("└", "┴", "┘"));
  return out;
}
