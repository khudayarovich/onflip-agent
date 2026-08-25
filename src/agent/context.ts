import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { configDir } from "../config";

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
  ".cursorrules",
  ".github/copilot-instructions.md",
];

const MAX_INSTRUCTION_BYTES = 32_000;

export interface ProjectContext {
  cwd: string;
  /** Concatenated instruction files, empty when the project ships none. */
  instructions: string;
  /** Which files the instructions came from, for display. */
  instructionSources: string[];
  git: GitInfo | null;
  environment: string;
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
  remote?: string;
  recentCommits: string[];
}

function readIfSmall(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Walk from cwd up to the repo/home root collecting instruction files. */
function collectInstructions(cwd: string): { text: string; sources: string[] } {
  const chunks: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();

  // A global file applies to every project the user runs the agent in.
  const globalFile = path.join(configDir(), "AGENTS.md");
  const globalText = readIfSmall(globalFile);
  if (globalText?.trim()) {
    chunks.push(`# Global instructions (${globalFile})\n\n${globalText.trim()}`);
    sources.push(globalFile);
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

  for (const ancestor of ancestors) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(ancestor, name);
      if (seen.has(file)) continue;
      const text = readIfSmall(file);
      if (!text?.trim()) continue;
      seen.add(file);
      chunks.push(`# Project instructions (${path.relative(cwd, file) || name})\n\n${text.trim()}`);
      sources.push(file);
    }
  }

  return { text: chunks.join("\n\n---\n\n"), sources };
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

function describeEnvironment(cwd: string, info: GitInfo | null): string {
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

  // A shallow listing saves the model an opening `list` call almost every time.
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
  const { text, sources } = collectInstructions(cwd);
  return {
    cwd,
    instructions: text,
    instructionSources: sources,
    git: info,
    environment: describeEnvironment(cwd, info),
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
