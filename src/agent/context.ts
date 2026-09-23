import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { configDir } from "../config";
import { discoverSkills, Skill } from "./skills";
import { projectMapFor } from "./project-map";

/**
 * Project context assembled once per session and prepended to the system
 * prompt: instruction files the repo ships, plus a snapshot of the environment
 * so the model does not have to spend turns discovering it.
 */

/** Instruction files, in ascending precedence. */
const INSTRUCTION_FILES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "ONFLIP.md",
  ".onflip/instructions.md",
  // Facts the agent itself recorded with the `remember` tool.
  ".onflip/memory.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

export const MAX_INSTRUCTION_BYTES = 32_000;

/**
 * What every instruction file together may hold: what one file may.
 *
 * The cap was per file only, and a folder may have eight of them, plus each
 * folder above it and the global one. OnFlip's own system prompt is about
 * 22,000 characters; with 32 KB of instructions a first send is near 55,000,
 * inside the 60,831 the composer is known to accept, where four files at the
 * per-file cap made about 150,000 — past the 112,586 it is known to refuse,
 * so every send in that folder would have failed.
 */
export const MAX_INSTRUCTION_TOTAL_BYTES = 32_000;

export interface ProjectContext {
  cwd: string;
  /** Concatenated instruction files, empty when the project ships none. */
  instructions: string;
  /** Instruction files found but left out: see `SkippedInstructions`. */
  instructionsSkipped: SkippedInstructions[];
  /**
   * Skills available here: names and one-line descriptions only.
   *
   * Deliberately not concatenated into `instructions`. The whole point is
   * that a skill's body stays out of the prompt until a task needs it.
   */
  skills: Skill[];
  /** Which files the instructions came from, for display. */
  instructionSources: string[];
  git: GitInfo | null;
  environment: string;
  /**
   * An outline of the project's files, taken when the session began; ""
   * for a folder that is not a project (a home directory, a drive root) or
   * that holds nothing. See `agent/project-map.ts`.
   */
  projectMap?: string;
}

/** An instruction file left out, and which limit it was over. */
export interface SkippedInstructions {
  file: string;
  bytes: number;
  /** `file`: over `MAX_INSTRUCTION_BYTES` alone; `total`: no room left under `MAX_INSTRUCTION_TOTAL_BYTES`. */
  reason: "file" | "total";
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
  remote?: string;
  recentCommits: string[];
}

/**
 * Instruction files that were found and then left out for being too large.
 *
 * Collected per load so the skip can be said out loud. It used to be
 * silent, and silence is the whole problem: this repo's own AGENTS.md is
 * 89 KB against a 32 KB cap, so the single most useful document in the tree
 * was dropped from every prompt and nothing anywhere said so.
 *
 * The cap itself stays. Instructions are re-sent with every turn and are
 * subtracted from the transcript budget before it is divided, so an 89 KB
 * file would not merely be expensive - it is larger than the whole budget a
 * paid plan gets. The answer to a file over the cap is to split it, which is
 * advice nobody can act on without being told.
 */
let skipped: SkippedInstructions[] = [];

function readIfSmall(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_INSTRUCTION_BYTES) {
      skipped.push({ file, bytes: stat.size, reason: "file" });
      return null;
    }
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Walk from cwd up to the repo/home root collecting instruction files. */
function collectInstructions(cwd: string): {
  text: string;
  sources: string[];
  skipped: SkippedInstructions[];
} {
  /** In the order they are sent: global, then outermost folder to this one. */
  const found: { file: string; header: string; text: string; rank: number }[] = [];
  const seen = new Set<string>();
  skipped = [];

  // A global file applies to every project the user runs the agent in.
  const globalFile = path.join(configDir(), "AGENTS.md");
  const globalText = readIfSmall(globalFile);
  if (globalText?.trim()) {
    found.push({ file: globalFile, header: `# Global instructions (${globalFile})`, text: globalText.trim(), rank: -1 });
  }

  // Ancestors first so the closest file wins by appearing last.
  const ancestors: string[] = [];
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  for (;;) {
    ancestors.unshift(dir);
    if (dir === root || fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  ancestors.forEach((ancestor, depth) => {
    INSTRUCTION_FILES.forEach((name, order) => {
      const file = path.join(ancestor, name);
      if (seen.has(file)) return;
      const text = readIfSmall(file);
      if (!text?.trim()) return;
      seen.add(file);
      found.push({
        file,
        header: `# Project instructions (${path.relative(cwd, file) || name})`,
        text: text.trim(),
        // Nearest folder first, and within a folder the listed order.
        rank: (ancestors.length - depth) * INSTRUCTION_FILES.length + order,
      });
    });
  });

  // What fits under the total, decided nearest first — the folder being
  // worked in says the most about the work, the global file the least — and
  // a file identical to one already in is not sent twice: CLAUDE.md is very
  // often a copy of AGENTS.md.
  const kept = new Set<(typeof found)[number]>();
  const texts = new Set<string>();
  let total = 0;
  const byRank = [...found].sort((a, b) => (a.rank < 0 ? 1 : b.rank < 0 ? -1 : a.rank - b.rank));
  for (const entry of byRank) {
    if (texts.has(entry.text)) continue;
    const bytes = Buffer.byteLength(entry.text, "utf8");
    if (total + bytes > MAX_INSTRUCTION_TOTAL_BYTES) {
      skipped.push({ file: entry.file, bytes, reason: "total" });
      continue;
    }
    texts.add(entry.text);
    total += bytes;
    kept.add(entry);
  }
  const included = found.filter((entry) => kept.has(entry));
  return {
    text: included.map((entry) => `${entry.header}\n\n${entry.text}`).join("\n\n---\n\n"),
    sources: included.map((entry) => entry.file),
    skipped,
  };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitInfo(cwd: string): GitInfo | null {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "detached";
  const status = git(cwd, ["status", "--porcelain"]) ?? "";
  const remote = git(cwd, ["remote", "get-url", "origin"]) ?? undefined;
  const log = git(cwd, ["log", "--oneline", "-5"]) ?? "";
  return {
    branch,
    dirty: status.trim().length > 0,
    remote,
    recentCommits: log.split("\n").filter(Boolean),
  };
}

function describeEnvironment(cwd: string, info: GitInfo | null, mapped: boolean): string {
  const lines = [
    `Working directory: ${cwd}`,
    `Platform: ${process.platform} (${os.release()})`,
    `Shell: ${process.platform === "win32" ? "PowerShell" : process.env.SHELL || "/bin/sh"}`,
    `Node: ${process.version}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ];
  if (info) {
    lines.push(`Git branch: ${info.branch}${info.dirty ? " (uncommitted changes present)" : " (clean)"}`);
    if (info.recentCommits.length) {
      lines.push(`Recent commits:\n${info.recentCommits.map((c) => `  ${c}`).join("\n")}`);
    }
  } else {
    lines.push("Git: not a repository");
  }

  // A shallow listing saves the model an opening `list` call almost every
  // time. The project map says all of it and more, so it stands in for this
  // wherever there is one.
  if (mapped) return lines.join("\n");
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length) lines.push(`Top-level entries: ${entries.join(", ")}`);
  } catch {
    /* unreadable cwd — the model can call `list` itself */
  }

  return lines.join("\n");
}

export function loadProjectContext(cwd: string): ProjectContext {
  const info = gitInfo(cwd);
  const { text, sources, skipped: skippedFiles } = collectInstructions(cwd);
  const projectMap = projectMapFor(cwd);
  return {
    cwd,
    instructions: text,
    instructionSources: sources,
    instructionsSkipped: skippedFiles,
    skills: discoverSkills(cwd),
    git: info,
    environment: describeEnvironment(cwd, info, projectMap !== ""),
    projectMap,
  };
}

/** Template written by `/init` when a project has no AGENTS.md yet. */
export function initTemplate(cwd: string, info: GitInfo | null): string {
  const name = path.basename(cwd);
  return [
    `# ${name}`,
    "",
    "Instructions for AI coding agents working in this repository.",
    "",
    "## Overview",
    "",
    "<!-- What this project is, in two or three sentences. -->",
    "",
    "## Commands",
    "",
    "```bash",
    "# build",
    "# test",
    "# lint",
    "```",
    "",
    "## Architecture",
    "",
    "<!-- The handful of things that are not obvious from reading one file. -->",
    "",
    "## Conventions",
    "",
    "<!-- Naming, formatting, error handling, testing style. -->",
    "",
    info ? `## Branch\n\nDefault branch: ${info.branch}\n` : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}
