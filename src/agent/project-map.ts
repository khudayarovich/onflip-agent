import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { IGNORED_DIRS } from "../tools/util";

/**
 * Where things are in a project, before the model has to go and look.
 *
 * A session's first steps went on finding the code. `read` is the tool the
 * agent calls most, and a fresh session opened with a survey — list, glob,
 * grep, read — before it touched anything, every step a whole round trip to
 * a chat model that takes seconds to answer. Two things here cut that short.
 * The map is a compact outline of the project's files that rides in the
 * system prompt, so the model starts out knowing the layout; and the symbol
 * index answers "where is X defined" in one call, which is what most of
 * those surveys were for.
 *
 * Both are best-effort. A folder that cannot be listed gets no map and a
 * file that cannot be read has no symbols; neither can fail a session.
 */

/**
 * Never listed, even where git has not been told to ignore them.
 *
 * `git ls-files --others` lists what is untracked and not ignored, and a
 * project that forgot to ignore `node_modules` would otherwise spend the
 * whole map on it.
 */
const NEVER_LIST = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".idea",
  ".vs",
  "Pods",
  ".onflip",
]);

/** The most files a listing keeps. */
const MAX_FILES = 20_000;
/** The deepest a walk goes. */
const MAX_DEPTH = 12;
/** The most the map adds to the system prompt. */
export const MAX_MAP_CHARS = 2_400;
/** A folder with more files than this is summarised rather than named file by file. */
const NAME_FILES_UP_TO = 24;
/** The longest one folder's line may be. */
const MAX_FOLDER_LINE = 360;
/** How many names a summarised folder shows, to give its naming pattern. */
const EXAMPLE_NAMES = 4;

/** Code, beyond what the symbol index reads: a folder of these is where the work is. */
const MORE_SOURCE_EXTS = [".css", ".scss", ".sass", ".less", ".html", ".sql", ".m", ".mm", ".dart", ".r", ".jl", ".zig", ".hs", ".fs", ".clj", ".erl", ".vb"];

/** Files nobody edits by hand: a folder of only these says little about the project. */
const ASSET_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".svg",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".jar",
  ".node",
  ".dll",
  ".exe",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".lock",
]);

export interface ProjectListing {
  /** Relative to the folder listed, with forward slashes, sorted. */
  files: string[];
  /** Git's list of tracked and unignored files, or a walk of the folder. */
  source: "git" | "walk";
  /** The listing stopped at its file, depth or time limit: there are more. */
  partial: boolean;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a folder is somewhere a project could be.
 *
 * A drive root or a home directory is not: listing one is slow, and its map
 * would be a list of everything the person owns.
 */
export function isProjectFolder(dir: string): boolean {
  const root = path.resolve(dir);
  if (samePath(root, path.parse(root).root)) return false;
  return !samePath(root, path.resolve(os.homedir()));
}

/**
 * The project's files: git's own list where the folder is in a repository —
 * it already knows what is ignored — and otherwise a breadth-first walk that
 * skips dependency and build folders and stops at `budgetMs`, so a folder
 * that turns out to be enormous costs a moment rather than a hang.
 */
export function listProjectFiles(dir: string, budgetMs = 400): ProjectListing | null {
  const root = path.resolve(dir);
  if (!isProjectFolder(root)) return null;
  return gitListing(root) ?? walkListing(root, budgetMs);
}

function gitListing(root: string): ProjectListing | null {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    // Not a repository, no git, or a repository git will not read.
    return null;
  }
  // A path in the middle of a merge is listed once per stage.
  const files = [...new Set(out.split("\0").filter(Boolean))]
    .filter((file) => !file.split("/").some((part) => NEVER_LIST.has(part)))
    .sort();
  return { files: files.slice(0, MAX_FILES), source: "git", partial: files.length > MAX_FILES };
}

function walkListing(root: string, budgetMs: number): ProjectListing {
  const files: string[] = [];
  const deadline = Date.now() + budgetMs;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let partial = false;
  for (let i = 0; i < queue.length; i++) {
    if (files.length >= MAX_FILES || Date.now() > deadline) {
      partial = true;
      break;
    }
    const { dir, depth } = queue[i];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const hidden = entry.name.startsWith(".") && entry.name !== ".github";
        if (hidden || IGNORED_DIRS.has(entry.name) || NEVER_LIST.has(entry.name)) continue;
        if (depth >= MAX_DEPTH) {
          partial = true;
          continue;
        }
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile()) {
        files.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  }
  if (files.length > MAX_FILES) partial = true;
  return { files: files.slice(0, MAX_FILES).sort(), source: "walk", partial };
}

/** Folders in the order a tree reads: each one's subfolders straight after it. */
function treeOrder(a: string, b: string): number {
  const pa = a ? a.split("/") : [];
  const pb = b ? b.split("/") : [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

function depthOf(dir: string): number {
  return dir ? dir.split("/").length : 0;
}

/**
 * Which folders the map keeps when it cannot keep them all.
 *
 * Depth alone got this wrong on the first real project it met: every
 * second-level folder ranked equal, so they went in alphabetically and
 * `.github/ISSUE_TEMPLATE/` was listed while `src/agent/` was not. The
 * folders a coding agent is asked to change come first — the root, then
 * source — then configuration and documents, then tests (whose names follow
 * a pattern a summary shows), and last whatever is hidden or holds nothing
 * anyone edits.
 */
function folderRank(dir: string, names: string[]): number {
  if (!dir) return 0;
  const parts = dir.split("/");
  if (parts.some((part) => part.startsWith("."))) return 4;
  const exts = names.map((name) => path.extname(name).toLowerCase());
  if (exts.every((ext) => ASSET_EXTS.has(ext))) return 4;
  if (parts.some((part) => /^(tests?|__tests__|specs?|e2e|fixtures?|__snapshots__)$/i.test(part))) return 3;
  const sources = exts.filter((ext) => RULES_BY_EXT[ext] || MORE_SOURCE_EXTS.includes(ext)).length;
  return sources * 2 >= names.length ? 1 : 2;
}

/** One folder's line: its files by name, or a summary when there are many. */
function folderLine(dir: string, names: string[]): string {
  const label = dir ? `${dir}/` : "./";
  const named = `${label} ${names.join(", ")}`;
  if (names.length <= NAME_FILES_UP_TO && named.length <= MAX_FOLDER_LINE) return named;
  const byExt = new Map<string, number>();
  for (const name of names) {
    const ext = path.extname(name) || "no extension";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const kinds = [...byExt.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([ext, n]) => `${n} ${ext}`)
    .join(", ");
  let line = `${label} ${names.length} files (${kinds}), e.g.`;
  for (const name of names.slice(0, EXAMPLE_NAMES)) {
    if (line.length + name.length + 2 > MAX_FOLDER_LINE) break;
    line += `${line.endsWith("e.g.") ? " " : ", "}${name}`;
  }
  return line;
}

/**
 * An outline of the project, never longer than `maxChars`.
 *
 * Each folder gets a line naming its files. When they will not all fit,
 * the shallow folders are kept — the top of a tree says the most about
 * where things are — and the rest are named with a count on a closing line,
 * so a folder left out is still known to exist.
 */
export function buildProjectMap(listing: ProjectListing | null, maxChars = MAX_MAP_CHARS): string {
  if (!listing || listing.files.length === 0) return "";
  const byDir = new Map<string, string[]>();
  for (const file of listing.files) {
    const at = file.lastIndexOf("/");
    const dir = at < 0 ? "" : file.slice(0, at);
    const name = file.slice(at + 1);
    const names = byDir.get(dir);
    if (names) names.push(name);
    else byDir.set(dir, [name]);
  }

  const count = listing.files.length;
  const head = `${count}${listing.partial ? "+" : ""} file${count === 1 ? "" : "s"}${
    listing.partial ? " (the listing stopped early; there are more)" : ""
  }.`;
  const rank = new Map([...byDir].map(([dir, names]) => [dir, folderRank(dir, names)]));
  const byPriority = [...byDir.keys()].sort(
    (a, b) => rank.get(a)! - rank.get(b)! || depthOf(a) - depthOf(b) || treeOrder(a, b)
  );
  // Room kept back for the line that names what was left out.
  const reserve = byDir.size > 1 ? 200 : 0;
  let room = maxChars - head.length - reserve;
  const shown = new Map<string, string>();
  const left: string[] = [];
  for (const dir of byPriority) {
    const line = folderLine(dir, byDir.get(dir)!);
    if (line.length + 1 <= room) {
      shown.set(dir, line);
      room -= line.length + 1;
    } else {
      left.push(dir);
    }
  }

  const lines = [head, ...[...shown.keys()].sort(treeOrder).map((dir) => shown.get(dir)!)];
  if (left.length) {
    const budget = maxChars - lines.join("\n").length - 1;
    const intro = `Not listed: ${left.length} more folder${left.length === 1 ? "" : "s"}`;
    const named: string[] = [];
    let line = `${intro}.`;
    for (const dir of left) {
      const piece = `${dir}/ (${byDir.get(dir)!.length})`;
      const next = `${intro}: ${[...named, piece].join(", ")}${named.length + 1 < left.length ? ", …" : ""}.`;
      if (next.length > budget) break;
      named.push(piece);
      line = next;
    }
    if (line.length <= budget) lines.push(line);
  }
  return lines.join("\n");
}

/** The map for a folder, or "" when it has none. */
export function projectMapFor(dir: string): string {
  try {
    return buildProjectMap(listProjectFiles(dir));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// the symbol index
// ---------------------------------------------------------------------------

export interface SymbolHit {
  /** Relative to the folder searched, with forward slashes. */
  file: string;
  line: number;
  kind: string;
  name: string;
  /** The defining line, trimmed. */
  text: string;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** The capture group holding the name. */
  name: number;
  /** The capture group holding the kind, where the keyword says it (Rust's struct, enum, trait). */
  kindFrom?: number;
}

/**
 * Definitions are read line by line with patterns, not parsed.
 *
 * A parser per language would be exact and would have to ship for every
 * language someone might open; a line pattern is right for the ordinary
 * way each language writes a definition and costs nothing to carry. The
 * price is known and paid on purpose: a definition written unusually is
 * missed, and the tool then says so and points at `grep`, which finds
 * anything.
 */
const JS: Rule[] = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, name: 1 },
  { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, name: 1 },
  { kind: "interface", re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, name: 1 },
  { kind: "type", re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<.*>)?\s*=/, name: 1 },
  { kind: "enum", re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, name: 1 },
  // const run = async (a, b) => …   const f = function …   const g = x => …
  {
    kind: "function",
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    name: 1,
  },
  // A top-level arrow whose parameters run onto the next lines.
  { kind: "function", re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\($/, name: 1 },
  // Top-level variables and constants; a local one is not a definition anyone
  // looks up, and `const fs = require("fs")` is an import.
  {
    kind: "variable",
    // (?![\w$]) first, or the lookahead is dodged by backtracking to a
    // shorter name: `f` out of `fs`, which is followed by no `=` at all.
    re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?![\w$])(?!\s*=\s*(?:await\s+)?(?:require|import)\s*\()/,
    name: 1,
  },
  // A class field holding a function: private onClick = () => …
  {
    kind: "method",
    re: /^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    name: 1,
  },
  // An object literal's function property: onClick: () => …
  {
    kind: "method",
    re: /^\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    name: 1,
  },
  // A method: name(args) { at the end of the line, in a class or an object.
  // The closing parenthesis is required: `buildPrompt({` ending a line is a
  // call taking an object literal, and it was the first false hit found.
  {
    kind: "method",
    re: /^\s+(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{\s*$/,
    name: 1,
  },
  // A method whose parameters run onto the next lines. The modifier is
  // required: without one, `doSomething(` is far more often a call.
  {
    kind: "method",
    re: /^\s+(?:(?:public|private|protected|static|override|abstract|async|get|set)\s+)+\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\($/,
    name: 1,
  },
];

const PY: Rule[] = [
  { kind: "function", re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, name: 1 },
  { kind: "method", re: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, name: 1 },
  { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/, name: 1 },
  { kind: "constant", re: /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=(?!=)/, name: 1 },
];

const GO: Rule[] = [
  { kind: "method", re: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, name: 1 },
  { kind: "function", re: /^func\s+([A-Za-z_]\w*)/, name: 1 },
  { kind: "type", re: /^type\s+([A-Za-z_]\w*)/, name: 1 },
  { kind: "variable", re: /^(?:var|const)\s+([A-Za-z_]\w*)/, name: 1 },
];

const RUST: Rule[] = [
  {
    kind: "function",
    re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
    name: 1,
  },
  { kind: "type", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(struct|enum|trait|union|type|mod)\s+([A-Za-z_]\w*)/, name: 2, kindFrom: 1 },
  { kind: "macro", re: /^\s*macro_rules!\s*([A-Za-z_]\w*)/, name: 1 },
  { kind: "constant", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/, name: 1 },
];

const RUBY: Rule[] = [
  { kind: "method", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, name: 1 },
  { kind: "class", re: /^\s*(?:class|module)\s+(?:[A-Z]\w*::)*([A-Z]\w*)/, name: 1 },
];

const PHP: Rule[] = [
  { kind: "function", re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, name: 1 },
  { kind: "class", re: /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, name: 1 },
];

/** Java, Kotlin, Scala and C#: close enough in how they declare things. */
const JVM: Rule[] = [
  {
    kind: "class",
    re: /^\s*(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open|partial|inner|enum|annotation|value|case|implicit)\s+)*(?:class|interface|enum|record|struct|object|trait)\s+([A-Za-z_]\w*)/,
    name: 1,
  },
  {
    kind: "function",
    re: /^\s*(?:(?:public|private|protected|internal|override|suspend|inline|operator|infix|tailrec|open|abstract|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\s*\(/,
    name: 1,
  },
  { kind: "method", re: /^\s*(?:(?:override|private|protected|final|implicit|lazy)\s+)*def\s+([A-Za-z_]\w*)/, name: 1 },
  {
    kind: "method",
    re: /^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|synchronized|native|sealed|extern|unsafe|new)\s+)+(?:<[^>]*>\s+)?[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^;]*$/,
    name: 1,
  },
];

const SWIFT: Rule[] = [
  {
    kind: "function",
    re: /^\s*(?:@\w+\s+)*(?:(?:public|private|internal|fileprivate|open|static|class|override|final|mutating|nonmutating)\s+)*func\s+([A-Za-z_]\w*)/,
    name: 1,
  },
  {
    kind: "type",
    re: /^\s*(?:@\w+\s+)*(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/,
    name: 2,
    kindFrom: 1,
  },
];

/**
 * C and C++. A function definition is taken only at the start of a line and
 * only without a trailing semicolon, which is how definitions are written
 * and prototypes are not. Each word of the return type is followed by
 * separators the name cannot contain, so the pattern stays linear on long
 * lines instead of backtracking through every split of them.
 */
const C: Rule[] = [
  { kind: "macro", re: /^\s*#\s*define\s+([A-Za-z_]\w*)/, name: 1 },
  {
    kind: "type",
    re: /^\s*(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?(struct|class|union|enum(?:\s+class)?)\s+(?:[A-Z][A-Z0-9_]*\s+)?([A-Za-z_]\w*)[^;]*$/,
    name: 2,
    kindFrom: 1,
  },
  {
    kind: "function",
    re: /^(?!(?:return|else|if|for|while|switch|case|do|goto|typedef|using|namespace|public|private|protected|delete|throw)\b)(?:[A-Za-z_][\w:<>,]*[\s*&]+)+([A-Za-z_~][\w~]*(?:::[A-Za-z_~][\w~]*)*)\s*\([^;]*$/,
    name: 1,
  },
];

const SHELL: Rule[] = [
  { kind: "function", re: /^\s*function\s+([A-Za-z_][\w-]*)/, name: 1 },
  { kind: "function", re: /^\s*([A-Za-z_][\w-]*)\s*\(\)/, name: 1 },
];

const POWERSHELL: Rule[] = [{ kind: "function", re: /^\s*(?:function|filter)\s+(?:global:|script:)?([A-Za-z_][\w-]*)/i, name: 1 }];

const LUA: Rule[] = [{ kind: "function", re: /^\s*(?:local\s+)?function\s+(?:[A-Za-z_]\w*[.:])*([A-Za-z_]\w*)/, name: 1 }];

const ELIXIR: Rule[] = [
  { kind: "module", re: /^\s*defmodule\s+(?:[A-Z]\w*\.)*([A-Z]\w*)/, name: 1 },
  { kind: "function", re: /^\s*defp?\s+([a-z_]\w*[?!]?)/, name: 1 },
];

const RULES_BY_EXT: Record<string, Rule[]> = {
  ".js": JS,
  ".jsx": JS,
  ".mjs": JS,
  ".cjs": JS,
  ".ts": JS,
  ".tsx": JS,
  ".mts": JS,
  ".cts": JS,
  ".vue": JS,
  ".svelte": JS,
  ".py": PY,
  ".pyi": PY,
  ".go": GO,
  ".rs": RUST,
  ".rb": RUBY,
  ".rake": RUBY,
  ".php": PHP,
  ".java": JVM,
  ".kt": JVM,
  ".kts": JVM,
  ".scala": JVM,
  ".cs": JVM,
  ".swift": SWIFT,
  ".c": C,
  ".h": C,
  ".cc": C,
  ".cpp": C,
  ".cxx": C,
  ".hpp": C,
  ".hh": C,
  ".hxx": C,
  ".sh": SHELL,
  ".bash": SHELL,
  ".zsh": SHELL,
  ".ps1": POWERSHELL,
  ".psm1": POWERSHELL,
  ".lua": LUA,
  ".ex": ELIXIR,
  ".exs": ELIXIR,
};

function rulesFor(file: string): Rule[] | undefined {
  if (/\.min\.[cm]?js$/i.test(file)) return undefined;
  return RULES_BY_EXT[path.extname(file).toLowerCase()];
}

/** Words the method patterns would otherwise read as names. */
const NOT_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "else",
  "do",
  "try",
  "with",
  "new",
  "typeof",
  "await",
  "super",
  "constructor",
]);

/** A line longer than this is generated or minified, and holds no definition anyone wrote. */
const MAX_LINE = 400;

/** The definitions in one file's text, by the patterns for its extension. */
export function extractSymbols(file: string, text: string): SymbolHit[] {
  const rules = rulesFor(file);
  if (!rules) return [];
  const hits: SymbolHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE || !line.trim()) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      let name = m[rule.name];
      // C++'s Class::method is looked up as method.
      if (name?.includes("::")) name = name.slice(name.lastIndexOf("::") + 2);
      if (!name || NOT_NAMES.has(name)) continue;
      const kind = rule.kindFrom ? m[rule.kindFrom].replace(/\s+/g, " ") : rule.kind;
      hits.push({ file, line: i + 1, kind, name, text: line.trim().slice(0, 160) });
      break;
    }
  }
  return hits;
}

/** Files the index reads at most, and the largest file it reads. */
const MAX_INDEXED_FILES = 8_000;
const MAX_INDEXED_BYTES = 512 * 1024;
/** Folders whose index is kept at once. */
const MAX_ROOTS = 4;

interface FileIndex {
  mtimeMs: number;
  size: number;
  symbols: SymbolHit[];
}

/** Per folder searched: each source file's definitions, kept until the file changes. */
const indexes = new Map<string, Map<string, FileIndex>>();

/** Most recently used last, so the oldest is the one dropped. */
function indexFor(root: string): Map<string, FileIndex> {
  const index = indexes.get(root) ?? new Map<string, FileIndex>();
  indexes.delete(root);
  indexes.set(root, index);
  while (indexes.size > MAX_ROOTS) indexes.delete(indexes.keys().next().value as string);
  return index;
}

const KIND_RANK: Record<string, number> = {
  class: 0,
  interface: 0,
  type: 0,
  struct: 0,
  enum: 0,
  "enum class": 0,
  trait: 0,
  union: 0,
  protocol: 0,
  actor: 0,
  module: 0,
  mod: 0,
  function: 1,
  macro: 1,
  method: 2,
  constant: 3,
  variable: 4,
};

function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__|specs?)\//i.test(file) || /[._-](test|spec)s?\.[^/]+$/i.test(file);
}

/** Definitions before tests, types and functions before variables, then by place. */
function byRelevance(a: SymbolHit, b: SymbolHit): number {
  return (
    Number(isTestFile(a.file)) - Number(isTestFile(b.file)) ||
    (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.line - b.line
  );
}

export interface SymbolSearch {
  hits: SymbolHit[];
  /** How the name matched: exactly, ignoring case, or inside a longer name. */
  match: "exact" | "case" | "partial" | "none";
  /** Further matches past the limit. */
  more: number;
  /** Source files whose definitions were searched. */
  files: number;
  /** The search did not cover the whole folder: too many files, or out of time. */
  partial: boolean;
  /** The folder is not one a project could be — a drive root or a home directory. */
  unsearchable?: boolean;
}

/** `Engine.start`, `Engine::start` and `Engine#start` are all looked up as `start`. */
export function symbolName(query: string): string {
  const parts = query.trim().split(/::|[.#]/).filter(Boolean);
  return (parts[parts.length - 1] ?? "").replace(/\(.*$/, "").trim();
}

/**
 * The definitions whose name matches `query`: exactly first, then ignoring
 * case, then containing it. A file is read again only when its size or
 * modification time has moved since it was last read, so the index kept
 * across a session follows the agent's own edits without re-reading the
 * rest of the project.
 */
export function findSymbols(
  dir: string,
  query: string,
  opts: { limit?: number; budgetMs?: number; signal?: AbortSignal } = {}
): SymbolSearch {
  const limit = opts.limit ?? 20;
  const root = path.resolve(dir);
  const listing = listProjectFiles(root, 2_000);
  if (!listing) return { hits: [], match: "none", more: 0, files: 0, partial: false, unsearchable: true };

  const sources = listing.files.filter((file) => rulesFor(file));
  const previous = indexFor(root);
  const index = new Map<string, FileIndex>();
  const deadline = Date.now() + (opts.budgetMs ?? 8_000);
  let partial = listing.partial || sources.length > MAX_INDEXED_FILES;
  const all: SymbolHit[] = [];
  let files = 0;
  for (const file of sources.slice(0, MAX_INDEXED_FILES)) {
    if (opts.signal?.aborted) {
      partial = true;
      break;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(root, file));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_INDEXED_BYTES) continue;
    let entry = previous.get(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      if (Date.now() > deadline) {
        // Out of time: what is already read still answers, and the next
        // search carries on from here rather than starting over.
        partial = true;
        continue;
      }
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, file), "utf8");
      } catch {
        continue;
      }
      entry = { mtimeMs: stat.mtimeMs, size: stat.size, symbols: extractSymbols(file, text) };
    }
    index.set(file, entry);
    files++;
    for (const symbol of entry.symbols) all.push(symbol);
  }
  indexes.set(root, index);

  const name = symbolName(query);
  if (!name) return { hits: [], match: "none", more: 0, files, partial };
  const lower = name.toLowerCase();
  let match: SymbolSearch["match"] = "exact";
  let found = all.filter((s) => s.name === name);
  if (!found.length) {
    match = "case";
    found = all.filter((s) => s.name.toLowerCase() === lower);
  }
  if (!found.length) {
    match = "partial";
    found = all.filter((s) => s.name.toLowerCase().includes(lower));
  }
  if (!found.length) match = "none";
  found.sort(byRelevance);
  return { hits: found.slice(0, limit), match, more: Math.max(0, found.length - limit), files, partial };
}

/** For tests: forget every index. */
export function forgetSymbolIndexes(): void {
  indexes.clear();
}
