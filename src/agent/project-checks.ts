import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { configDir } from "../config";

/**
 * The checks that passed in a project before, remembered by OnFlip rather
 * than by the model.
 *
 * Every session in a project rediscovered how to check its work: whether
 * there is a build script, whether the tests are `npm test` or something
 * else, which folder the typecheck runs from — round trips at the start of
 * every task, and sometimes a failed guess first. OnFlip already sees every
 * command it runs and how it exited, so it keeps the checks that passed,
 * per project, and the next session starts with them.
 *
 * Kept narrow on purpose:
 *
 *   Only checks — build, test, lint and typecheck commands, recognised by
 *   shape — and only ones OnFlip saw exit 0. Nothing the model *says* goes
 *   in, only what ran, so this is not a channel for planting instructions
 *   the way a file in the repository is (see `isInstructionFile`).
 *
 *   Only plain commands: words, paths and flags. Anything with quotes, a
 *   variable, a comment or a secret-looking word is not recorded, because
 *   the record ends up in a prompt and a canonical check needs none of it.
 *
 *   Outside the repository, under the config folder, so it never shows up
 *   in anybody's diff; and forgotten after thirty days without passing.
 */

export interface KnownCheck {
  /** The check as run, e.g. `npm run typecheck`. */
  command: string;
  /** The folder it ran in, relative to the project; "" for the project itself. */
  dir: string;
  /** How many times it has passed. */
  passes: number;
  /** When it last passed, epoch ms. */
  lastPassedAt: number;
  /** How long it took the last time it passed. */
  lastMs: number;
}

interface Stored {
  cwd: string;
  checks: KnownCheck[];
}

/** Checks kept per project. */
const MAX_CHECKS = 8;
/** Shown in the prompt. */
const SHOWN_CHECKS = 6;
/** A check not seen to pass for this long is forgotten. */
const FORGET_AFTER_MS = 30 * 24 * 60 * 60_000;
/** Longer than this is a script, not a check anybody would repeat. */
const MAX_COMMAND = 100;

/**
 * Commands that check work rather than do it, by their opening words.
 *
 * `npm install`, `npm run dev` and `npm start` are not here: they change
 * the machine or run forever, and "it passed" means nothing for either.
 */
const CHECKS: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|type-check|check|verify|tsc|ci)([:\w-]*)(\s|$)/,
  /^npx\s+(tsc|eslint|vitest|jest|mocha|ava|prettier\s+--check|playwright\s+test)(\s|$)/,
  /^(tsc|eslint|vitest|jest|mocha|pytest|ruff|mypy|pyright|flake8|rubocop|rspec|phpunit|phpstan)(\s|$)/,
  /^(python3?|py)\s+-m\s+(pytest|unittest|mypy|ruff|flake8|compileall)(\s|$)/,
  /^node\s+--test(\s|$)/,
  /^cargo\s+(build|test|check|clippy)(\s|$)/,
  /^go\s+(build|test|vet)(\s|$)/,
  /^dotnet\s+(build|test)(\s|$)/,
  /^(mvn|\.[\\/]mvnw|gradle|\.[\\/]gradlew(\.bat)?)\s+(\S+\s+)*(test|verify|build|check|compile|package)(\s|$)/,
  /^make(\s+(test|check|build|lint|all))?$/,
  /^swift\s+(build|test)(\s|$)/,
  /^deno\s+(test|check|lint)(\s|$)/,
];

/** Words, paths and flags only: no quotes, variables, globs or comments. */
const PLAIN = /^[\w@./\\:=,+-]+(\s+[\w@./\\:=,+-]+)*$/;
/** Not recorded at all, whatever else the command is. */
const SECRET = /(token|secret|passw(or)?d|api[-_]?key|credential|auth)/i;

/** Tails that trim what a check prints, not what it checks. */
const DISPLAY_TAIL = /(\s*(\d?>&\d|2>\s*\$null|2>\s*\/dev\/null|>\s*\/dev\/null|\|\s*(tail|head|Select-Object|more|Out-String|Out-Host)\b[^|]*))+\s*$/i;
/** A change of folder at the front of a line: `cd x`, `Set-Location x`, `pushd x`. */
const CHANGE_DIR = /^(cd|Set-Location|sl|pushd|Push-Location)\s+(\S+)$/i;

export interface CheckRun {
  command: string;
  /** The folder it ran in, relative to the project; "" for the project itself. */
  dir: string;
}

/**
 * The checks a command line ran, if that is all it ran.
 *
 * `cd desktop && npm run typecheck 2>&1 | tail -5` is the check
 * `npm run typecheck` in `desktop`. A line that also does anything that is
 * not a check — `npm run build && node deploy.js` — records nothing: it
 * passing says as much about the deploy as about the build. After `;` only
 * the last command's exit is known, so only it is recorded; after `&&`
 * every command before a passing last one passed too.
 */
export function checksIn(line: string, shellDir = ""): CheckRun[] {
  const text = line.trim();
  // A check is a short line. A long one is a script, and not worth running
  // the patterns below over.
  if (!text || text.length > 400 || text.includes("\n") || SECRET.test(text)) return [];
  // Segments at even indexes, the separator after each at the odd ones.
  const parts = text.split(/\s*(&&|;)\s*/);
  let dir = shellDir.replace(/\\/g, "/");
  const found: { run: CheckRun; after: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i].replace(DISPLAY_TAIL, "").trim();
    if (!segment) return [];
    const moved = CHANGE_DIR.exec(segment);
    if (moved) {
      // A change of folder between checks makes the line a script.
      if (found.length) return [];
      const target = moved[2];
      if (!/^[\w./\\-]+$/.test(target) || path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) return [];
      dir = path.posix.normalize(path.posix.join(dir || ".", target.replace(/\\/g, "/")));
      if (dir === "." || dir === "./") dir = "";
      dir = dir.replace(/\/$/, "");
      if (dir.startsWith("..")) return [];
      continue;
    }
    if (segment.length > MAX_COMMAND || !PLAIN.test(segment) || !CHECKS.some((re) => re.test(segment))) return [];
    found.push({ run: { command: segment.replace(/\s+/g, " "), dir }, after: parts[i + 1] ?? "" });
  }
  // Exit 0 says the last command passed. One before it passed too only if
  // everything after it was chained with `&&`; after a `;` it is unknown.
  const runs: CheckRun[] = [];
  let chained = true;
  for (let k = found.length - 1; k >= 0; k--) {
    if (k < found.length - 1 && found[k].after !== "&&") chained = false;
    if (chained) runs.unshift(found[k].run);
  }
  return runs;
}

function storeFile(project: string): string {
  const key = createHash("sha256").update(path.resolve(project).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(configDir(), "projects", `${key}.json`);
}

/** The checks remembered for a project, freshest first, stale ones gone. */
export function knownChecks(project: string, now = Date.now()): KnownCheck[] {
  try {
    const stored = JSON.parse(fs.readFileSync(storeFile(project), "utf8")) as Stored;
    if (!Array.isArray(stored.checks)) return [];
    return stored.checks
      .filter(
        (c) =>
          c &&
          typeof c.command === "string" &&
          PLAIN.test(c.command) &&
          typeof c.lastPassedAt === "number" &&
          now - c.lastPassedAt < FORGET_AFTER_MS
      )
      .sort((a, b) => b.lastPassedAt - a.lastPassedAt);
  } catch {
    return [];
  }
}

export interface PassedCommand {
  /** The project: the folder the session was opened on. */
  project: string;
  /** The command line, as run. */
  line: string;
  /** Where the shell was when it started. */
  startDir: string;
  /** Where the shell was when it finished, when the shell said. */
  endDir?: string;
  /** How long it took. */
  ms: number;
  now?: number;
}

/**
 * A path as the filesystem names it. The shell can report a folder under a
 * name the session did not use — Windows's 8.3 short form of a temp
 * folder, a macOS `/tmp` that is really `/private/tmp` — and compared
 * lexically the two looked like different folders.
 *
 * A folder that does not exist is named through its nearest existing
 * parent. Canonicalising only the paths that exist is worse than not at
 * all: under CI's short-named temp folder the project came back long and
 * its subfolder stayed short, and every check run there was taken for one
 * run outside the project.
 */
function real(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(p);
}

/** A folder inside the project, relative with forward slashes, or null. */
function inside(root: string, dir: string): string | null {
  const rel = path.relative(real(root), real(dir)).replace(/\\/g, "/");
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
}

/**
 * Note a command line that exited 0.
 *
 * The folder is worked out from any `cd` at the front of the line, and then
 * checked against where the shell actually ended up: `cd desktop; npm test`
 * with no `desktop` folder runs the tests at the top, and recording them
 * under `desktop/` would send the next session to a folder that is not
 * there.
 *
 * Best-effort, like every other persistence here: a config folder that
 * cannot be written loses a hint, never a turn.
 */
export function notePassedCommand(run: PassedCommand): void {
  try {
    const now = run.now ?? Date.now();
    const root = path.resolve(run.project);
    const start = inside(root, run.startDir);
    if (start === null) return;
    const runs = checksIn(run.line, start);
    if (!runs.length) return;
    if (run.endDir !== undefined && inside(root, run.endDir) !== runs[runs.length - 1].dir) return;
    const ms = run.ms;
    const checks = knownChecks(root, now);
    // A chain has one duration for all of it. It is kept for a check that
    // ran alone, and only borrowed by one that has never been timed alone.
    const alone = runs.length === 1;
    for (const check of runs) {
      const same = checks.find((c) => c.command === check.command && c.dir === check.dir);
      if (same) {
        same.passes += 1;
        same.lastPassedAt = now;
        if (alone) same.lastMs = Math.round(ms);
      } else {
        checks.push({ ...check, passes: 1, lastPassedAt: now, lastMs: Math.round(ms) });
      }
    }
    checks.sort((a, b) => b.lastPassedAt - a.lastPassedAt);
    const file = storeFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stored: Stored = { cwd: root, checks: checks.slice(0, MAX_CHECKS) };
    fs.writeFileSync(file, JSON.stringify(stored, null, 2), "utf8");
  } catch {
    // A lost hint, not a lost turn.
  }
}

function seconds(ms: number): string {
  if (ms < 1_000) return "under a second";
  const s = Math.round(ms / 1_000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/** The checks as the system prompt shows them, or "" when there are none. */
export function renderKnownChecks(checks: KnownCheck[]): string {
  if (!checks.length) return "";
  return checks
    .slice(0, SHOWN_CHECKS)
    .map((c) => `- ${c.dir ? `in ${c.dir}/: ` : ""}\`${c.command}\` — ${seconds(c.lastMs)}`)
    .join("\n");
}

/** For tests: where a project's record lives. */
export function checksFileFor(project: string): string {
  return storeFile(project);
}
