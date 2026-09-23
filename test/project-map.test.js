"use strict";

/**
 * The project map and `find_symbol`: knowing where things are without a
 * survey.
 *
 * A fresh session used to open with list, glob, grep and read — a round trip
 * to the chat model each — before it changed anything, and "where is X
 * defined?" was a grep for a guessed pattern and a page of usages. The map
 * rides in the system prompt; the symbol index answers the question in one
 * call and re-reads only what has changed since.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-map-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
fs.mkdirSync(process.env.ONFLIP_CONFIG_DIR, { recursive: true });

const {
  listProjectFiles,
  buildProjectMap,
  projectMapFor,
  extractSymbols,
  findSymbols,
  symbolName,
  forgetSymbolIndexes,
  isProjectFolder,
  MAX_MAP_CHARS,
} = require("../dist/agent/project-map");
const { loadProjectContext } = require("../dist/agent/context");
const { buildSystemPrompt } = require("../dist/agent/system");
const { createToolRegistry } = require("../dist/tools/index");

function project(files) {
  const root = fs.mkdtempSync(path.join(HOME, "proj-"));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();

function inRepository(dir) {
  try {
    return git(dir, "rev-parse", "--is-inside-work-tree").trim() === "true";
  } catch {
    return false;
  }
}

const symbols = (file, text) => extractSymbols(file, text).map((s) => `${s.kind} ${s.name}`);

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

test("a repository is listed by git: ignored files out, untracked ones in", () => {
  const root = project({
    ".gitignore": "*.log\nbuilt/\n",
    "src/app.ts": "export function main() {}\n",
    "src/new-file.ts": "export const x = 1;\n",
    "debug.log": "noise\n",
    "built/out.js": "compiled\n",
    // Forgotten in .gitignore, and still never listed.
    "node_modules/pkg/index.js": "module.exports = 1;\n",
  });
  git(root, "init", "-q");
  git(root, "add", ".gitignore", "src/app.ts");
  const listing = listProjectFiles(root);
  assert.equal(listing.source, "git");
  assert.deepEqual(listing.files, [".gitignore", "src/app.ts", "src/new-file.ts"]);
  assert.equal(listing.partial, false);
});

test("a folder outside any repository is walked, skipping dependencies and build output", (t) => {
  const root = project({
    "main.py": "def run():\n    pass\n",
    "lib/util.py": "class Helper:\n    pass\n",
    "node_modules/x/y.js": "",
    "dist/bundle.js": "",
    ".secret/notes.txt": "",
    ".github/workflows/ci.yml": "",
  });
  if (inRepository(root)) return t.skip("the temp folder is inside a git repository here");
  const listing = listProjectFiles(root);
  assert.equal(listing.source, "walk");
  assert.deepEqual(listing.files, [".github/workflows/ci.yml", "lib/util.py", "main.py"]);
});

test("a home directory or a drive root is not a project, and gets no map", () => {
  assert.equal(isProjectFolder(os.homedir()), false);
  assert.equal(isProjectFolder(path.parse(process.cwd()).root), false);
  assert.equal(listProjectFiles(os.homedir()), null);
  assert.equal(projectMapFor(os.homedir()), "");
  assert.equal(isProjectFolder(process.cwd()), true);
});

// ---------------------------------------------------------------------------
// the map
// ---------------------------------------------------------------------------

test("a small project is listed file by file, folder by folder", () => {
  const map = buildProjectMap({
    files: ["README.md", "package.json", "src/index.ts", "src/util.ts", "test/index.test.js"],
    source: "git",
    partial: false,
  });
  assert.equal(
    map,
    ["5 files.", "./ README.md, package.json", "src/ index.ts, util.ts", "test/ index.test.js"].join("\n")
  );
});

test("the map never outgrows its budget, and says what it left out", () => {
  const files = [];
  for (let d = 0; d < 300; d++) {
    for (let f = 0; f < 15; f++) files.push(`packages/pkg-${d}/src/module-number-${f}.ts`);
  }
  files.push("package.json");
  const map = buildProjectMap({ files, source: "git", partial: false });
  assert.ok(map.length <= MAX_MAP_CHARS, `${map.length} > ${MAX_MAP_CHARS}`);
  assert.match(map, /^4501 files\./);
  assert.match(map, /^\.\/ package\.json$/m, "the root is always there");
  assert.match(map, /^Not listed: \d+ more folders: packages\/pkg-\d+\/src\/ \(15\)/m, "left-out folders are named");
  for (const budget of [200, 600, 1_000]) {
    assert.ok(buildProjectMap({ files, source: "git", partial: false }, budget).length <= budget, `budget ${budget}`);
  }
});

test("source folders are kept ahead of hidden, asset and test folders", () => {
  // The first real project the map met listed .github/ISSUE_TEMPLATE/ and
  // left out src/agent/: depth alone ranked them equal.
  const files = [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/workflows/ci.yml",
    "assets/logo.png",
    "assets/icon.ico",
    "package.json",
  ];
  for (let i = 0; i < 12; i++) files.push(`src/agent/module-${i}.ts`);
  for (let i = 0; i < 40; i++) files.push(`test/case-${i}.test.js`);
  const map = buildProjectMap({ files, source: "git", partial: false }, 420);
  assert.match(map, /^src\/agent\/ module-0\.ts/m, "the source folder is listed");
  assert.doesNotMatch(map, /^\.github\/ISSUE_TEMPLATE\/ /m, "the hidden folder is not listed");
  assert.match(map, /Not listed: .*\.github\/ISSUE_TEMPLATE\/ \(2\)/, "it is still named");
});

test("a folder of many files is summarised with its naming pattern", () => {
  const files = [];
  for (let i = 0; i < 60; i++) files.push(`test/case-${String(i).padStart(2, "0")}.test.js`);
  const map = buildProjectMap({ files, source: "walk", partial: false });
  assert.match(map, /^test\/ 60 files \(60 \.js\), e\.g\. case-00\.test\.js, case-01\.test\.js, case-02\.test\.js, case-03\.test\.js$/m);
});

test("a listing that stopped early says so", () => {
  const map = buildProjectMap({ files: ["a.ts"], source: "walk", partial: true });
  assert.match(map, /^1\+ file \(the listing stopped early; there are more\)\./);
});

// ---------------------------------------------------------------------------
// reading definitions
// ---------------------------------------------------------------------------

test("TypeScript and JavaScript definitions are found", () => {
  const src = [
    "export async function runTurn(",
    "export default class Engine extends Base {",
    "export interface ToolResult {",
    "export type Handler<T = string> = (value: T) => void;",
    "export const enum Mode { A }",
    "export const handle = async (req: Request): Promise<void> => {",
    "const pick = x => x;",
    "export const build = (",
    "export const LIMIT = 5;",
    "  private async startWatch(): Promise<void> {",
    "  static create<T>(opts: T) {",
    "  private async relocate(",
    "  private onClick = () => {",
    "  onProgress: (chunk) => {",
    "  get value() {",
  ].join("\n");
  assert.deepEqual(symbols("src/engine.ts", src), [
    "function runTurn",
    "class Engine",
    "interface ToolResult",
    "type Handler",
    "enum Mode",
    "function handle",
    "function pick",
    "function build",
    "variable LIMIT",
    "method startWatch",
    "method create",
    "method relocate",
    "method onClick",
    "method onProgress",
    "method value",
  ]);
});

test("calls, control flow, imports and locals are not definitions", () => {
  const src = [
    "    buildSystemPrompt({",
    "  if (ready) {",
    "  for (const item of items) {",
    "  } else if (other) {",
    '  describe("thing", () => {',
    "  useEffect(() => {",
    "  await sendTurn(",
    "  doSomething(",
    "  const local = 1;",
    '  constructor(private readonly name: string) {',
    'const fs = require("node:fs");',
    'const { join } = require("node:path");',
    "// function commented() {}",
    " * function inDocComment() {}",
  ].join("\n");
  assert.deepEqual(symbols("src/x.ts", src), []);
});

test("definitions in the other languages it reads", () => {
  assert.deepEqual(symbols("a.py", "class Engine:\n    async def run(self):\ndef main():\nMAX_SIZE = 10\nx == 1\n"), [
    "class Engine",
    "method run",
    "function main",
    "constant MAX_SIZE",
  ]);
  assert.deepEqual(symbols("a.go", "func (e *Engine) Start() error {\nfunc main() {\ntype Config struct {\nvar Version = \"1\"\n"), [
    "method Start",
    "function main",
    "type Config",
    "variable Version",
  ]);
  assert.deepEqual(
    symbols("a.rs", "pub async fn serve() {\npub(crate) struct Server {\ntrait Handler {\nmacro_rules! log {\npub const MAX: usize = 3;\n"),
    ["function serve", "struct Server", "trait Handler", "macro log", "constant MAX"]
  );
  assert.deepEqual(symbols("a.rb", "module Billing\n  class Invoice\n    def self.total?\n"), [
    "class Billing",
    "class Invoice",
    "method total?",
  ]);
  assert.deepEqual(symbols("a.php", "final class Router {\n    public static function dispatch($r) {\n"), [
    "class Router",
    "function dispatch",
  ]);
  assert.deepEqual(
    symbols("A.java", "public class Store {\n    public static List<String> names(int n) {\n    private final Map<String, Integer> counts = new HashMap<>();\n"),
    ["class Store", "method names"]
  );
  assert.deepEqual(symbols("A.kt", "data class User(val id: Int)\nsuspend fun load(id: Int): User {\n"), [
    "class User",
    "function load",
  ]);
  assert.deepEqual(symbols("A.cs", "public sealed class Api {\n    public async Task<int> GetAsync(int id)\n"), [
    "class Api",
    "method GetAsync",
  ]);
  assert.deepEqual(symbols("a.swift", "public struct Point {\n    mutating func move(by d: Int) {\n"), [
    "struct Point",
    "function move",
  ]);
  assert.deepEqual(
    symbols("a.c", "#define MAX_LEN 64\nstruct node {\nstatic int count_nodes(struct node *n) {\nint count_nodes(struct node *n);\nchar *copy_name(const char *s)\n"),
    ["macro MAX_LEN", "struct node", "function count_nodes", "function copy_name"]
  );
  assert.deepEqual(symbols("a.cpp", "void Engine::start(int x) {\n"), ["function start"]);
  assert.deepEqual(symbols("a.sh", "deploy() {\nfunction cleanup {\n"), ["function deploy", "function cleanup"]);
  assert.deepEqual(symbols("a.ps1", "Function Get-Thing {\nfunction script:Set-Other {\n"), [
    "function Get-Thing",
    "function Set-Other",
  ]);
  assert.deepEqual(symbols("a.lua", "local function helper()\nfunction M.render(x)\n"), [
    "function helper",
    "function render",
  ]);
  assert.deepEqual(symbols("a.ex", "defmodule MyApp.Repo do\n  defp fetch!(id) do\n"), ["module Repo", "function fetch!"]);
  assert.deepEqual(symbols("notes.md", "function notCode() {}\n"), [], "a language it does not read");
  assert.deepEqual(symbols("vendor.min.js", "function minified(){}\n"), [], "minified code");
});

test("a very long line is not read, and does not hang the reader", () => {
  const long = `int ${"a ".repeat(5_000)}(`;
  const started = Date.now();
  assert.deepEqual(symbols("a.c", long), []);
  // Long enough to be read, and failing to match at the very end: the shape
  // that makes a backtracking pattern try every split of the words before.
  const medium = `${"unsigned long ".repeat(26)}value`;
  assert.ok(medium.length < 400);
  assert.deepEqual(symbols("a.c", `${medium}\n`.repeat(2_000)), []);
  assert.ok(Date.now() - started < 1_000, "linear, not backtracking through every split");
});

test("a qualified name is looked up by its last part", () => {
  assert.equal(symbolName("Engine.start"), "start");
  assert.equal(symbolName("Engine::start"), "start");
  assert.equal(symbolName("Engine#start"), "start");
  assert.equal(symbolName("start()"), "start");
  assert.equal(symbolName("  runTurn "), "runTurn");
});

// ---------------------------------------------------------------------------
// searching
// ---------------------------------------------------------------------------

test("an exact match beats one ignoring case, which beats a partial one", () => {
  forgetSymbolIndexes();
  const root = project({
    "src/a.ts": "export function runTurn() {}\nexport function runturnHelper() {}\n",
    "src/b.ts": "export function RunTurn() {}\n",
  });
  assert.deepEqual(
    findSymbols(root, "runTurn").hits.map((h) => h.name),
    ["runTurn"]
  );
  const folded = findSymbols(root, "RUNTURN");
  assert.equal(folded.match, "case");
  assert.deepEqual(folded.hits.map((h) => h.name).sort(), ["RunTurn", "runTurn"]);
  const partial = findSymbols(root, "turnhelp");
  assert.equal(partial.match, "partial");
  assert.deepEqual(partial.hits.map((h) => h.name), ["runturnHelper"]);
  assert.equal(findSymbols(root, "nothingLikeIt").match, "none");
});

test("definitions in source come before tests, and types before variables", () => {
  forgetSymbolIndexes();
  const root = project({
    "test/engine.test.ts": "class Engine {}\n",
    "src/state.ts": "export const Engine = 1;\n",
    "src/engine.ts": "export class Engine {}\n",
  });
  const found = findSymbols(root, "Engine");
  assert.deepEqual(
    found.hits.map((h) => `${h.file} ${h.kind}`),
    ["src/engine.ts class", "src/state.ts variable", "test/engine.test.ts class"]
  );
});

test("a file is read again once it changes, and forgotten once it is gone", () => {
  forgetSymbolIndexes();
  const root = project({ "src/a.ts": "export function first() {}\n", "src/b.ts": "export function other() {}\n" });
  assert.equal(findSymbols(root, "first").hits.length, 1);
  const file = path.join(root, "src/a.ts");
  fs.writeFileSync(file, "export function first() {}\nexport function second() {}\n");
  // The index keys on size and modification time; a rewrite changes both.
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(file, later, later);
  assert.deepEqual(findSymbols(root, "second").hits.map((h) => `${h.file}:${h.line}`), ["src/a.ts:2"]);
  // The same size again: only the modification time says it changed.
  fs.writeFileSync(file, "export function zirst() {}\nexport function zecond() {}\n");
  const latest = new Date(Date.now() + 10_000);
  fs.utimesSync(file, latest, latest);
  assert.equal(findSymbols(root, "zecond").hits.length, 1);
  fs.rmSync(path.join(root, "src/b.ts"));
  assert.equal(findSymbols(root, "other").match, "none");
});

test("the search stops when the turn is interrupted, and says it did not finish", () => {
  forgetSymbolIndexes();
  const root = project({ "a.ts": "export function one() {}\n" });
  const ctl = new AbortController();
  ctl.abort();
  const found = findSymbols(root, "one", { signal: ctl.signal });
  assert.equal(found.partial, true);
  assert.equal(found.hits.length, 0);
});

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

const registry = (cwd) =>
  createToolRegistry({
    cwd,
    session: { todos: [], snapshots: [], readFiles: new Map(), fullReads: new Map() },
    signal: new AbortController().signal,
    requestPermission: async () => ({ outcome: "allow" }),
  });

test("find_symbol answers with path:line, the kind and the defining line", async () => {
  forgetSymbolIndexes();
  const root = project({ "pkg/src/run.ts": "// header\nexport async function runTurn(opts: Options) {\n" });
  const reg = registry(root);
  const result = await reg.run("find_symbol", { symbol: "runTurn" });
  assert.equal(result.error, undefined);
  assert.equal(result.output, "pkg/src/run.ts:2  function  export async function runTurn(opts: Options) {");
  // A folder given as `path` still answers with paths from the working directory.
  const scoped = await reg.run("find_symbol", { symbol: "runTurn", path: "pkg" });
  assert.equal(scoped.output, result.output);
  // The names a model reaches for out of habit, for the tool and the argument.
  assert.equal((await reg.run("find_definition", { symbol: "runTurn" })).output, result.output);
  assert.equal((await reg.run("find_symbol", { name: "runTurn" })).output, result.output);
});

test("a block that writes `name:` for the argument still reaches the tool", async () => {
  // In a block `name:` can also mean `tool:`; once the tool is named, a
  // later `name:` is the argument, and the lookup must not arrive empty.
  const { parseTurn } = require("../dist/agent/protocol");
  const root = project({ "a.ts": "export function one() {}\n" });
  const reg = registry(root);
  const fence = "`".repeat(3);
  const [call] = parseTurn(`${fence}onflip\ntool: find_symbol\nname: one\n${fence}`, (n) => !!reg.get(n)).calls;
  const result = await reg.run(call.tool, call.arguments);
  assert.equal(result.output, "a.ts:1  function  export function one() {}");
});

test("find_symbol that finds nothing says what to do instead", async () => {
  forgetSymbolIndexes();
  const root = project({ "a.ts": "export function one() {}\n" });
  const result = await registry(root).run("find_symbol", { symbol: "Engine.start$" });
  assert.equal(result.error, undefined, "an empty answer is an answer, not a failure");
  assert.match(result.output, /No definition of `Engine\.start\$` found in 1 source file\./);
  assert.match(result.output, /grep for it: `pattern: start\\\$`/, "the bare name, escaped for a regex");
});

test("find_symbol refuses a file or a missing folder with the fix", async () => {
  const root = project({ "a.ts": "export function one() {}\n" });
  const reg = registry(root);
  const onFile = await reg.run("find_symbol", { symbol: "one", path: "a.ts" });
  assert.equal(onFile.error, true);
  assert.match(onFile.output, /a\.ts is a file\. Pass the folder to search as `path`, or leave it out\./);
  const missing = await reg.run("find_symbol", { symbol: "one", path: "nope" });
  assert.equal(missing.error, true);
  assert.match(missing.output, /Folder not found: nope/);
  assert.equal((await reg.run("find_symbol", {})).error, true);
});

// ---------------------------------------------------------------------------
// the prompt
// ---------------------------------------------------------------------------

const prompt = (context) =>
  buildSystemPrompt({
    tools: registry(process.cwd()).list,
    context: { cwd: process.cwd(), instructions: "", skills: [], environment: "Working directory: x", ...context },
    approvalMode: "ask",
    shellEnabled: true,
  });

test("the map rides in the prompt after the environment, and only when there is one", () => {
  const withMap = prompt({ projectMap: "3 files.\nsrc/ a.ts, b.ts, c.ts" });
  assert.match(withMap, /## Environment\n\nWorking directory: x\n\n## Project map\n\n.*\n\n3 files\.\nsrc\/ a\.ts, b\.ts, c\.ts/);
  assert.doesNotMatch(prompt({ projectMap: "" }), /## Project map/);
  assert.doesNotMatch(prompt({}), /## Project map/);
});

test("the tool is documented, and arguments are not all labelled string", () => {
  const text = prompt({});
  assert.match(text, /### find_symbol\n/);
  assert.match(text, /^- symbol \(required\): The name to look up, e\.g\. runTurn or Engine\.start$/m);
  assert.doesNotMatch(text, /\(string[,)]/, "every value is text; the label said nothing");
  assert.match(text, /^- context \(number\): /m, "a type that is not text is still named");
});

test("a project's context carries its map in place of the top-level listing", () => {
  const root = project({ "src/app.ts": "export function main() {}\n", "README.md": "# app\n" });
  const ctx = loadProjectContext(root);
  assert.match(ctx.projectMap, /^2 files\.\n\.\/ README\.md\nsrc\/ app\.ts$/);
  assert.doesNotMatch(ctx.environment, /Top-level entries/, "said twice otherwise");
  assert.equal(loadProjectContext(os.homedir()).projectMap, "");
});
