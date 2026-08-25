import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition, ToolContext, FileSnapshot } from "../types";
import { err, ok, denied, asNumber, asBool, resolveIn, relative, isProbablyBinary, IGNORED_DIRS } from "./util";

const MAX_READ_BYTES = 400_000;
const MAX_READ_LINES = 2_000;
const MAX_LIST_ENTRIES = 1_000;
const MAX_GREP_MATCHES = 300;
const MAX_GLOB_RESULTS = 500;

function snapshot(
  ctx: ToolContext,
  file: string,
  before: string | null,
  after: string | null,
  tool: string
): void {
  const entry: FileSnapshot = { path: file, before, after, tool, at: Date.now() };
  ctx.session.snapshots.push(entry);
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Warn when a file has changed on disk since the agent last read it — the user
 * edited it in their own editor, a build regenerated it, or another process
 * touched it. Left silent, the agent would overwrite that change believing it
 * still knows the file's contents.
 */
function staleReadWarning(ctx: ToolContext, file: string): string | null {
  const readAt = ctx.session.readFiles.get(file);
  if (readAt === undefined) return null;
  try {
    if (fs.statSync(file).mtimeMs > readAt + 1_000) {
      return `Note: ${relative(ctx.cwd, file)} changed on disk after you read it. Your edit was applied to the current contents, but re-read the file before making further changes.`;
    }
  } catch {
    /* the file vanished — the caller's own error handling covers that */
  }
  return null;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file from the filesystem. Returns the contents with line numbers. Use offset/limit for large files. Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      offset: { type: "number", description: "1-based line to start from (optional)" },
      limit: { type: "number", description: "Maximum lines to return (optional, default 2000)" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return err(`File not found: ${relative(ctx.cwd, file)}`);
    }
    if (stat.isDirectory()) {
      return err(`Path is a directory, not a file: ${relative(ctx.cwd, file)}. Use "list" instead.`);
    }
    if (stat.size > MAX_READ_BYTES) {
      return err(
        `File is ${Math.round(stat.size / 1024)}KB, over the ${Math.round(MAX_READ_BYTES / 1024)}KB read limit. Use offset/limit, or "grep" to find the relevant part.`
      );
    }
    const buf = fs.readFileSync(file);
    if (isProbablyBinary(buf)) {
      return err(`Cannot read binary file: ${relative(ctx.cwd, file)} (${stat.size} bytes)`);
    }

    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    // A trailing newline terminates the last line rather than starting a new
    // one; keeping the empty tail would report every file as one line longer.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const offsetArg = asNumber(args.offset);
    const offset = offsetArg === undefined ? 1 : Math.max(1, Math.floor(offsetArg));
    const limitArg = asNumber(args.limit);
    const limit = limitArg === undefined ? MAX_READ_LINES : Math.max(1, Math.floor(limitArg));
    const end = Math.min(lines.length, offset + limit - 1);

    ctx.session.readFiles.set(file, Date.now());

    if (offset > lines.length) {
      return ok(`(no such line — file has ${lines.length} lines)`, {
        title: relative(ctx.cwd, file),
      });
    }

    const width = String(end).length;
    const body: string[] = [];
    for (let i = offset; i <= end; i++) {
      body.push(`${String(i).padStart(width)}│ ${lines[i - 1]}`);
    }
    const truncated = end < lines.length;
    if (truncated) {
      body.push(`… ${lines.length - end} more lines (use offset ${end + 1} to continue)`);
    }

    return ok(body.join("\n"), {
      title: `${relative(ctx.cwd, file)} (${lines.length} lines)`,
      display: { kind: "text", lines: body, lang: path.extname(file).slice(1) },
    });
  },
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create a new file or overwrite an existing one with the given content. Parent directories are created automatically. Prefer 'edit' for changing part of an existing file.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    if (typeof args.content !== "string") return err("`content` must be a string");
    const content = args.content;
    const before = readIfExists(file);

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "write",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [before === null ? "create new file" : "overwrite existing file"],
    });
    if (!decision.allow) {
      return denied("Write", decision.reason);
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    snapshot(ctx, file, before, content, "write");
    ctx.session.readFiles.set(file, Date.now());

    const lineCount = content.split("\n").length;
    return ok(
      `${before === null ? "Created" : "Overwrote"} ${relative(ctx.cwd, file)} (${lineCount} lines)`,
      {
        title: relative(ctx.cwd, file),
        display: { kind: "diff", path: file, oldText: before ?? "", newText: content },
      }
    );
  },
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string in a file. `old_string` must appear exactly once unless `replace_all` is true. Read the file first so the string matches byte for byte, including indentation.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      old_string: { type: "string", description: "Exact text to replace, including surrounding context to make it unique" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    const before = readIfExists(file);
    if (before === null) return err(`File not found: ${relative(ctx.cwd, file)}`);

    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    if (!oldStr) return err("`old_string` must be non-empty. Use the `write` tool to create a file.");
    if (oldStr === newStr) return err("`old_string` and `new_string` are identical — nothing to do.");

    const occurrences = before.split(oldStr).length - 1;
    if (occurrences === 0) {
      return err(
        `\`old_string\` not found in ${relative(ctx.cwd, file)}. Read the file again — whitespace and indentation must match exactly.`
      );
    }
    const replaceAll = asBool(args.replace_all);
    if (occurrences > 1 && !replaceAll) {
      return err(
        `\`old_string\` matches ${occurrences} places in ${relative(ctx.cwd, file)}. Add surrounding context to make it unique, or pass replace_all: true.`
      );
    }

    const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "edit",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [`${occurrences} replacement${occurrences === 1 ? "" : "s"}`],
    });
    if (!decision.allow) {
      return denied("Edit", decision.reason);
    }

    const stale = staleReadWarning(ctx, file);
    fs.writeFileSync(file, after, "utf8");
    snapshot(ctx, file, before, after, "edit");
    ctx.session.readFiles.set(file, Date.now());

    const summary = `Applied ${occurrences} replacement${occurrences === 1 ? "" : "s"} in ${relative(ctx.cwd, file)}`;
    return ok(stale ? `${summary}\n${stale}` : summary, {
      title: relative(ctx.cwd, file),
      display: { kind: "diff", path: file, oldText: before, newText: after },
    });
  },
};

// ---------------------------------------------------------------------------
// multi_edit
// ---------------------------------------------------------------------------

export const multiEditTool: ToolDefinition = {
  name: "multi_edit",
  description:
    "Apply several edits to one file in a single atomic operation. Edits run in order; if any fails, the file is left untouched. Use this instead of repeated `edit` calls on the same file.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      edits: {
        type: "array",
        description: "Ordered list of replacements",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    const before = readIfExists(file);
    if (before === null) return err(`File not found: ${relative(ctx.cwd, file)}`);
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return err("`edits` must be a non-empty array");
    }

    let working = before;
    let applied = 0;
    for (const [i, raw] of (args.edits as unknown[]).entries()) {
      const e = raw as Record<string, unknown>;
      const oldStr = String(e.old_string ?? "");
      const newStr = String(e.new_string ?? "");
      if (!oldStr) return err(`edits[${i}]: \`old_string\` must be non-empty`);
      const count = working.split(oldStr).length - 1;
      if (count === 0) {
        return err(
          `edits[${i}]: \`old_string\` not found${applied ? " after the preceding edits were applied" : ""}. No changes were written.`
        );
      }
      if (count > 1 && !asBool(e.replace_all)) {
        return err(
          `edits[${i}]: \`old_string\` matches ${count} places. Add context or set replace_all. No changes were written.`
        );
      }
      working = asBool(e.replace_all) ? working.split(oldStr).join(newStr) : working.replace(oldStr, newStr);
      applied += count;
    }

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "multi_edit",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [`${(args.edits as unknown[]).length} edits, ${applied} replacements`],
    });
    if (!decision.allow) {
      return denied("Edits", decision.reason);
    }

    const stale = staleReadWarning(ctx, file);
    fs.writeFileSync(file, working, "utf8");
    snapshot(ctx, file, before, working, "multi_edit");
    ctx.session.readFiles.set(file, Date.now());

    const summary = `Applied ${(args.edits as unknown[]).length} edits (${applied} replacements) to ${relative(ctx.cwd, file)}`;
    return ok(stale ? `${summary}\n${stale}` : summary, {
      title: relative(ctx.cwd, file),
      display: { kind: "diff", path: file, oldText: before, newText: working },
    });
  },
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export const listTool: ToolDefinition = {
  name: "list",
  description:
    "List the contents of a directory as a tree. Skips node_modules, .git, dist and similar build output.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (defaults to the working directory)" },
      depth: { type: "number", description: "How many levels to descend (default 2, max 6)" },
      all: { type: "boolean", description: "Include dotfiles and ignored directories" },
    },
  },
  async run(args, ctx) {
    const dir = resolveIn(ctx.cwd, args.path);
    if (!fs.existsSync(dir)) return err(`Directory not found: ${relative(ctx.cwd, dir)}`);
    if (!fs.statSync(dir).isDirectory()) return err(`Not a directory: ${relative(ctx.cwd, dir)}`);

    const maxDepth = Math.min(6, Math.max(1, asNumber(args.depth) ?? 2));
    const showAll = asBool(args.all);
    const lines: string[] = [];
    let truncated = false;

    const walk = (d: string, depth: number, prefix: string): void => {
      if (depth > maxDepth || truncated) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      const visible = items
        .filter((it) => showAll || (!it.name.startsWith(".") && !IGNORED_DIRS.has(it.name)))
        .sort((a, b) =>
          a.isDirectory() !== b.isDirectory()
            ? a.isDirectory()
              ? -1
              : 1
            : a.name.localeCompare(b.name)
        );

      visible.forEach((it, idx) => {
        if (lines.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        const last = idx === visible.length - 1;
        const branch = last ? "└─ " : "├─ ";
        if (it.isDirectory()) {
          lines.push(`${prefix}${branch}${it.name}/`);
          walk(path.join(d, it.name), depth + 1, prefix + (last ? "   " : "│  "));
        } else {
          let size = "";
          try {
            size = ` (${formatSize(fs.statSync(path.join(d, it.name)).size)})`;
          } catch {
            /* unreadable entry — name alone is still useful */
          }
          lines.push(`${prefix}${branch}${it.name}${size}`);
        }
      });
    };

    lines.push(`${relative(ctx.cwd, dir) || "."}/`);
    walk(dir, 1, "");
    if (truncated) lines.push(`… truncated at ${MAX_LIST_ENTRIES} entries`);
    if (lines.length === 1) lines.push("(empty)");

    return ok(lines.join("\n"), {
      title: `${relative(ctx.cwd, dir) || "."} (${lines.length - 1} entries)`,
      display: { kind: "text", lines },
    });
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/** Translate a glob into an anchored regex. Supports **, *, ?, and {a,b}. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  const p = pattern.replace(/\\/g, "/");
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**/" spans any number of directories, including none.
        if (p[i + 2] === "/") {
          out += "(?:[^/]*\\/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      const close = p.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i += 1;
      } else {
        const options = p.slice(i + 1, close).split(",");
        out += `(?:${options.map(escapeRe).join("|")})`;
        i = close + 1;
      }
    } else {
      out += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by path pattern, e.g. '**/*.ts' or 'src/**/test_*.py'. Results are sorted by modification time, newest first.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the search root" },
      path: { type: "string", description: "Directory to search from (defaults to the working directory)" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const root = resolveIn(ctx.cwd, args.path);
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return err("`pattern` must be non-empty");
    if (!fs.existsSync(root)) return err(`Directory not found: ${relative(ctx.cwd, root)}`);

    let re: RegExp;
    try {
      re = globToRegExp(pattern);
    } catch (e) {
      return err(`Invalid pattern: ${e instanceof Error ? e.message : String(e)}`);
    }

    const found: { file: string; mtime: number }[] = [];
    const walk = (d: string): void => {
      if (found.length >= MAX_GLOB_RESULTS || ctx.signal.aborted) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        if (found.length >= MAX_GLOB_RESULTS || ctx.signal.aborted) return;
        const full = path.join(d, it.name);
        if (it.isDirectory()) {
          if (!IGNORED_DIRS.has(it.name)) walk(full);
          continue;
        }
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (re.test(rel)) {
          try {
            found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
          } catch {
            found.push({ file: full, mtime: 0 });
          }
        }
      }
    };
    walk(root);

    if (found.length === 0) return ok(`No files match ${pattern}`, { title: pattern });
    found.sort((a, b) => b.mtime - a.mtime);
    const lines = found.map((f) => relative(ctx.cwd, f.file));
    if (found.length >= MAX_GLOB_RESULTS) lines.push(`… capped at ${MAX_GLOB_RESULTS} results`);
    return ok(lines.join("\n"), {
      title: `${pattern} (${found.length} file${found.length === 1 ? "" : "s"})`,
      display: { kind: "text", lines },
    });
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns file:line matches. Use `include` to restrict by glob, e.g. '*.ts'.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      path: { type: "string", description: "Directory or file to search (defaults to the working directory)" },
      include: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'" },
      case_sensitive: { type: "boolean", description: "Match case exactly (default false)" },
      context: { type: "number", description: "Lines of context to show around each match" },
      files_only: { type: "boolean", description: "Return only the names of matching files" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const target = resolveIn(ctx.cwd, args.path);
    const patternStr = String(args.pattern ?? "");
    if (!patternStr) return err("`pattern` must be non-empty");
    if (!fs.existsSync(target)) return err(`Path not found: ${relative(ctx.cwd, target)}`);

    let re: RegExp;
    try {
      re = new RegExp(patternStr, asBool(args.case_sensitive) ? "" : "i");
    } catch (e) {
      return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    let includeRe: RegExp | null = null;
    if (typeof args.include === "string" && args.include.trim()) {
      const inc = args.include.trim();
      // A bare "*.ts" should match at any depth.
      includeRe = globToRegExp(inc.includes("/") ? inc : `**/${inc}`);
    }

    const contextLines = Math.min(5, Math.max(0, asNumber(args.context) ?? 0));
    const filesOnly = asBool(args.files_only);
    const matches: string[] = [];
    const matchedFiles = new Set<string>();
    let scanned = 0;
    let capped = false;

    const searchFile = (file: string): void => {
      if (capped || ctx.signal.aborted) return;
      const rel = path.relative(target, file).replace(/\\/g, "/");
      if (includeRe && !includeRe.test(rel) && !includeRe.test(path.basename(file))) return;
      let buf: Buffer;
      try {
        const st = fs.statSync(file);
        if (st.size > 2_000_000) return;
        buf = fs.readFileSync(file);
      } catch {
        return;
      }
      if (isProbablyBinary(buf)) return;
      scanned++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matchedFiles.add(file);
        if (filesOnly) return;
        if (contextLines > 0) {
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length - 1, i + contextLines);
          for (let j = from; j <= to; j++) {
            const marker = j === i ? ":" : "-";
            matches.push(`${relative(ctx.cwd, file)}${marker}${j + 1}${marker} ${lines[j].slice(0, 300)}`);
          }
          matches.push("--");
        } else {
          matches.push(`${relative(ctx.cwd, file)}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
        if (matches.length >= MAX_GREP_MATCHES) {
          capped = true;
          return;
        }
      }
    };

    const walk = (d: string): void => {
      if (capped || ctx.signal.aborted) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        if (capped || ctx.signal.aborted) return;
        const full = path.join(d, it.name);
        if (it.isDirectory()) {
          if (!IGNORED_DIRS.has(it.name)) walk(full);
        } else if (!it.name.startsWith(".")) {
          searchFile(full);
        }
      }
    };

    if (fs.statSync(target).isDirectory()) walk(target);
    else searchFile(target);

    if (filesOnly) {
      const files = [...matchedFiles].map((f) => relative(ctx.cwd, f));
      if (files.length === 0) return ok(`No files contain /${patternStr}/`, { title: patternStr });
      return ok(files.join("\n"), {
        title: `${patternStr} (${files.length} file${files.length === 1 ? "" : "s"})`,
        display: { kind: "text", lines: files },
      });
    }

    if (matches.length === 0) {
      return ok(`No matches for /${patternStr}/ across ${scanned} files`, { title: patternStr });
    }
    if (capped) matches.push(`… capped at ${MAX_GREP_MATCHES} matches — narrow the pattern`);
    return ok(matches.join("\n"), {
      title: `${patternStr} (${matchedFiles.size} file${matchedFiles.size === 1 ? "" : "s"})`,
      display: { kind: "text", lines: matches },
    });
  },
};

export const FS_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  listTool,
  globTool,
  grepTool,
];
