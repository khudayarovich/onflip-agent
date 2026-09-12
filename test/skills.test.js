"use strict";

/**
 * Skills: instructions the agent reads only when a task needs them.
 *
 * The problem is measurable in this repository. Instruction files go into the
 * system prompt, which is re-sent every turn and comes off the transcript
 * budget before it is divided — so they are capped at 32 KB, and this
 * project's own AGENTS.md is 89 KB and was being dropped from every prompt.
 * Splitting it is the only real answer and there was nowhere to split it to.
 *
 * So the thing worth testing is not that skills load. It is that the listing
 * stays cheap: names and one line each, bodies left on disk.
 *
 * `node --test` gives each file its own process, so redirecting the home
 * directory here cannot touch the real ~/.onflip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-skills-home-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { discoverSkills, renderSkills, parseFrontmatter, MAX_SKILLS } = require("../dist/agent/skills");

const GLOBAL = path.join(HOME, ".onflip", "skills");
fs.mkdirSync(GLOBAL, { recursive: true });

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-skills-proj-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

const withFront = (name, description, body = "the long body") =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", body].join("\n");

test("a folder holding SKILL.md is a skill", () => {
  const dir = project({
    ".onflip/skills/deploy/SKILL.md": withFront("deploy", "Ship a build to staging."),
  });
  const found = discoverSkills(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "deploy");
  assert.equal(found[0].description, "Ship a build to staging.");
  assert.match(found[0].file, /SKILL\.md$/);
});

test("a bare .md file is a skill too", () => {
  const dir = project({ ".onflip/skills/release.md": withFront("release", "Cut a release.") });
  assert.equal(discoverSkills(dir)[0].name, "release");
});

test("no frontmatter falls back to the folder name and the first real line", () => {
  // A skill someone wrote by hand must still appear, not vanish silently.
  const dir = project({ ".onflip/skills/staging.md": "# Deploying to staging\n\nSteps follow." });
  const found = discoverSkills(dir);
  assert.equal(found[0].name, "staging");
  assert.equal(found[0].description, "Deploying to staging");
});

test("README.md is not a skill", () => {
  const dir = project({ ".onflip/skills/README.md": "# How to write skills" });
  assert.deepEqual(discoverSkills(dir), []);
});

test("a project skill replaces a global one of the same name", () => {
  fs.writeFileSync(path.join(GLOBAL, "notes.md"), withFront("notes", "The global version."));
  const dir = project({ ".onflip/skills/notes.md": withFront("notes", "The project version.") });
  const found = discoverSkills(dir);
  const notes = found.filter((s) => s.name === "notes");
  assert.equal(notes.length, 1, "not listed twice");
  assert.equal(notes[0].description, "The project version.");
  fs.rmSync(path.join(GLOBAL, "notes.md"));
});

test("global skills are found with no project ones at all", () => {
  fs.writeFileSync(path.join(GLOBAL, "global-only.md"), withFront("global-only", "Everywhere."));
  const dir = project({ "readme.txt": "no skills here" });
  assert.ok(discoverSkills(dir).some((s) => s.name === "global-only"));
  fs.rmSync(path.join(GLOBAL, "global-only.md"));
});

test("the body never reaches the prompt — that is the whole point", () => {
  const body = "SECRET-BODY-MARKER\n".repeat(500);
  const dir = project({
    ".onflip/skills/big/SKILL.md": withFront("big", "A skill with a large body.", body),
  });
  const rendered = renderSkills(discoverSkills(dir), dir);
  assert.doesNotMatch(rendered, /SECRET-BODY-MARKER/);
  assert.ok(rendered.length < 600, `listing is ${rendered.length} chars, not the ${body.length}-char body`);
});

test("a long description is cut, because prose belongs in the body", () => {
  const dir = project({
    ".onflip/skills/wordy.md": withFront("wordy", "x".repeat(500)),
  });
  assert.ok(discoverSkills(dir)[0].description.length <= 200);
});

test("no skills costs nothing at all", () => {
  // The common case: the section must not exist rather than be empty.
  assert.equal(renderSkills([]), "");
  assert.equal(renderSkills([], "/somewhere"), "");
});

test("a project skill is shown by relative path, a global one absolute", () => {
  fs.writeFileSync(path.join(GLOBAL, "faraway.md"), withFront("faraway", "Global."));
  const dir = project({ ".onflip/skills/nearby.md": withFront("nearby", "Local.") });
  const rendered = renderSkills(discoverSkills(dir), dir);
  assert.match(rendered, /read: \.onflip[\\/]skills[\\/]nearby\.md/);
  assert.match(rendered, /read: .*faraway\.md/);
  assert.doesNotMatch(rendered, new RegExp(`read: ${dir.replace(/[\\/]/g, "[\\\\/]")}`), "no absolute project paths");
  fs.rmSync(path.join(GLOBAL, "faraway.md"));
});

test("the listing is capped so a huge folder cannot swallow the prompt", () => {
  const files = {};
  for (let i = 0; i < MAX_SKILLS + 15; i++) {
    files[`.onflip/skills/s${String(i).padStart(3, "0")}.md`] = withFront(`s${i}`, "One of many.");
  }
  const dir = project(files);
  assert.equal(discoverSkills(dir).length, MAX_SKILLS);
});

test("frontmatter parsing handles the shapes people actually write", () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "quoted"\n---\nbody'), {
    name: "a",
    description: "quoted",
  });
  assert.deepEqual(parseFrontmatter("---\r\nname: a\r\n---\r\nbody"), { name: "a" });
  assert.deepEqual(parseFrontmatter("no frontmatter here"), {});
  assert.deepEqual(parseFrontmatter("---\nunterminated: yes\n"), {}, "an unclosed block is not frontmatter");
});
