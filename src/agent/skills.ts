import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "../config";

/**
 * Skills: instructions the agent reads only when it needs them.
 *
 * The problem they solve is measurable in this very repository. Instruction
 * files are concatenated into the system prompt, which is re-sent on every
 * turn and subtracted from the transcript budget before it is divided — so
 * they are capped at 32 KB, and this project's own `AGENTS.md` is 89 KB. It
 * was being dropped from every prompt entirely, and nothing said so until a
 * recent release made the skip visible. Splitting it is the only real answer,
 * and until now there was nowhere to split it *to*.
 *
 * A skill is that somewhere. Only its name and one line of description sit in
 * the prompt; the body is a file the agent reads with the `read` tool when a
 * task actually matches. Ten skills cost about as much prompt space as one
 * paragraph, and the one that gets read costs a turn — paid only when it is
 * worth paying.
 *
 * Deliberately not a new tool. Tools are themselves described in the prompt,
 * so adding one to fetch skills would spend the space this exists to save,
 * and `read` already does the job — reads are always permitted, so there is
 * no new approval surface either.
 *
 * Not to be confused with the Skill Hub in `desktop/shared/skills.ts`, which
 * is a different thing wearing the same word: ready-made prompts a person
 * picks from the composer with `@skill:`. Those are for the user to invoke.
 * These are for the agent to find.
 */

export interface Skill {
  /** Short identifier, from the frontmatter or the folder it lives in. */
  name: string;
  /** One line saying what it is for, which is all the prompt carries. */
  description: string;
  /** Absolute path to the file the agent reads. */
  file: string;
}

/**
 * Enough skills to be useful, few enough to stay cheap.
 *
 * The whole point is that the listing is small. A directory with hundreds of
 * skills would quietly undo that, so the list is capped and says so rather
 * than silently showing a subset.
 */
export const MAX_SKILLS = 40;
/** A description longer than this is prose, and prose belongs in the body. */
const MAX_DESCRIPTION = 200;
/** Frontmatter lives at the top; never read a whole skill to find its name. */
const HEAD_BYTES = 4_096;

/** Where skills are looked for, least specific first so a project's win. */
export function skillRoots(cwd: string): string[] {
  return [path.join(configDir(), "skills"), path.join(path.resolve(cwd), ".onflip", "skills")];
}

/** The first bytes of a file, without pulling a large one into memory. */
function readHead(file: string): string | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Read `name` and `description` out of a leading `---` block.
 *
 * A deliberately small parser rather than a YAML dependency: the only shapes
 * that matter are `key: value` on one line, optionally quoted. Anything it
 * does not understand is ignored rather than rejected, because a skill with
 * an odd frontmatter should still be listed under its folder's name instead
 * of vanishing with no explanation.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const normalised = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---")) return {};
  const end = normalised.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = normalised.slice(normalised.indexOf("\n", 3) + 1, end);

  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1].toLowerCase()] = value;
  }
  return out;
}

/** The body's first real line, for a skill whose frontmatter says nothing. */
function firstProseLine(text: string): string {
  const normalised = text.replace(/\r\n/g, "\n");
  const body = normalised.startsWith("---")
    ? normalised.slice(normalised.indexOf("\n---", 3) + 4)
    : normalised;
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function skillFrom(file: string, fallbackName: string): Skill | null {
  const head = readHead(file);
  if (head === null) return null;
  const front = parseFrontmatter(head);
  const name = (front.name || fallbackName).trim();
  if (!name) return null;
  const described = (front.description || front.when || firstProseLine(head)).trim();
  const description =
    described.length > MAX_DESCRIPTION ? `${described.slice(0, MAX_DESCRIPTION - 1)}…` : described;
  return { name, description, file };
}

/**
 * Every skill available here, project ones last so they win by name.
 *
 * Two layouts, because both are what people actually write: a folder holding
 * `SKILL.md` (which can carry scripts beside it) and a bare `*.md` file.
 */
export function discoverSkills(cwd: string): Skill[] {
  const found = new Map<string, Skill>();

  for (const root of skillRoots(cwd)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // no skills here, which is the ordinary case
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      let file: string | null = null;
      let fallback = entry.name;
      if (entry.isDirectory()) {
        const candidate = path.join(root, entry.name, "SKILL.md");
        if (fs.existsSync(candidate)) file = candidate;
      } else if (entry.isFile() && /\.md$/i.test(entry.name) && !/^readme\.md$/i.test(entry.name)) {
        file = path.join(root, entry.name);
        fallback = entry.name.replace(/\.md$/i, "");
      }
      if (!file) continue;
      const skill = skillFrom(file, fallback);
      // Keyed by name, and a later root overwrites an earlier one: a project
      // may deliberately replace a global skill with its own version.
      if (skill) found.set(skill.name, skill);
    }
  }

  return [...found.values()].slice(0, MAX_SKILLS);
}

/**
 * The listing that goes in the system prompt.
 *
 * Names, one line each, and the path to read. Nothing else — the body is the
 * whole reason this is not in the prompt already.
 */
export function renderSkills(skills: Skill[], cwd?: string): string {
  if (skills.length === 0) return "";

  // A project skill is shown relative to the working directory. The paths
  // are most of what this section weighs, and the point of the whole
  // arrangement is that it weighs very little.
  const show = (target: string): string => {
    if (!cwd) return target;
    const rel = path.relative(path.resolve(cwd), target);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target;
  };

  const lines = skills.map((skill) =>
    [
      `- **${skill.name}**${skill.description ? ` — ${skill.description}` : ""}`,
      `  read: ${show(skill.file)}`,
    ].join("\n")
  );

  return [
    "## Skills",
    "",
    "Instructions written for particular jobs on this machine. Only the names are here; each body is a file.",
    "",
    "When a task matches one, `read` its file before starting and follow it. When none matches, ignore this section — reading a skill that does not apply spends a turn for nothing.",
    "",
    ...lines,
  ].join("\n");
}
