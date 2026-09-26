"use strict";

/**
 * OnFlip checks the work itself before it takes a `done`.
 *
 * Counted over every session log on the development machine: of 23 turns
 * that changed files and ended on `done`, 8 ran a build, test or typecheck
 * after the last change, 9 only looked at the page, and 6 checked nothing —
 * so a broken build could reach the user as "done". OnFlip already records
 * the checks that passed in each project; now, when a `done` follows a change
 * nothing has checked, it runs the quickest of them through the ordinary
 * shell tool, and a failure goes back to the model once.
 *
 * The turns below run a real `node --test` through the real `bash` tool, so
 * they are slower than the rest of the suite, and bounded accordingly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-own-check-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";
// A test's shell can be slow to start on a cold runner; see AGENTS.md on
// asserting against a tuned constant.
process.env.ONFLIP_BACKGROUND_SETTLE_MS = "10000";

const { WorkLedger, pickOwnCheck, OWN_CHECK_MAX_MS } = require("../dist/agent/own-check");
const { runsACheck, notePassedCommand } = require("../dist/agent/project-checks");
const { runTurn } = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");
const { getShellCwd, resetShellCwd } = require("../dist/tools/shell");

const SLOW = { timeout: 120_000 };
const check = (command, dir, lastMs, passes = 1) => ({ command, dir, lastMs, passes, lastPassedAt: Date.now() });

// ---------------------------------------------------------------------------
// the rules
// ---------------------------------------------------------------------------

test("the check is the quickest that passed here, in a folder holding a change", () => {
  const project = path.join(HOME, "pick");
  const checks = [
    check("npm test", "", 40_000),
    check("npm run typecheck", "desktop", 6_000),
    check("npm run build", "", 12_000),
    check("npm run lint", "docs-site", 1_000),
  ];
  assert.equal(pickOwnCheck(checks, ["desktop/ui/App.tsx"], project).command, "npm run typecheck");
  // A change outside desktop/ is not judged by desktop's typecheck.
  assert.equal(pickOwnCheck(checks, ["src/agent/run.ts"], project).command, "npm run build");
  // Too slow to gate every `done`: a suite to run on purpose.
  assert.equal(pickOwnCheck([check("npm test", "", OWN_CHECK_MAX_MS + 1)], ["src/a.ts"], project), null);
});

test("prose, and files outside the project, are nothing a build can judge", () => {
  const project = path.join(HOME, "pick");
  const checks = [check("npm run build", "", 5_000)];
  assert.equal(pickOwnCheck(checks, ["README.md", "notes/plan.txt", "CHANGELOG.markdown"], project), null);
  assert.equal(pickOwnCheck(checks, [path.join(HOME, "elsewhere", "x.ts")], project), null);
  assert.equal(pickOwnCheck([], ["src/a.ts"], project), null);
  // One real change among the prose is enough.
  assert.equal(pickOwnCheck(checks, ["README.md", "src/a.ts"], project).command, "npm run build");
});

test("a command checked the work when any part of it is a check, however wrapped", () => {
  for (const line of [
    "npm run build",
    "cd desktop; npm run typecheck 2>&1 | Select-Object -Last 20",
    "npx tsc --noEmit -p .",
    "node --check game.js",
    "python -m py_compile app.py",
    "$env:CI=1; npm test",
    "cargo test --all",
  ]) {
    assert.equal(runsACheck(line), true, line);
  }
  // The false-positive half: doing things is not checking them.
  for (const line of ["npm run dev", "npm install", "python -m http.server 8000", "Get-Content app.js", "git status", "node server.js"]) {
    assert.equal(runsACheck(line), false, line);
  }
});

test("the ledger: a change opens the question, a passing check closes it", () => {
  const work = new WorkLedger();
  assert.equal(work.needsCheck, false);
  work.saw("write", { path: "app.js" }, { error: true });
  assert.equal(work.needsCheck, false, "a change that failed changed nothing");
  work.saw("edit", { path: "app.js" }, {});
  assert.equal(work.needsCheck, true);
  work.saw("bash", { command: "npm run dev", background: true }, {});
  assert.equal(work.needsCheck, true, "a server started is not a check");
  work.saw("bash", { command: "npm test" }, { error: true });
  assert.equal(work.needsCheck, true, "a check that failed checked nothing into place");
  work.saw("bash", { command: "npm test" }, {});
  assert.equal(work.needsCheck, false);
  work.saw("patch", { path: "src/b.ts" }, {});
  work.ranOwn(false);
  assert.equal(work.needsCheck, true, "OnFlip's own failure leaves it open");
  assert.equal(work.changedSinceOwnCheck, false);
  work.saw("write", { path: "src/b.ts" }, {});
  assert.equal(work.changedSinceOwnCheck, true);
  assert.deepEqual(work.changed, ["app.js", "src/b.ts"]);
});

// ---------------------------------------------------------------------------
// whole turns
// ---------------------------------------------------------------------------

const said = (role, content) => ({ id: `${role}-${Math.random()}`, role, content });
const writeApp = (text) => "```onflip\ntool: write\npath: app.js\ncontent: |\n  " + text + "\n```";
const DONE = "````onflip\ntool: done\nsummary: |\n  Finished.\n````";

/** A project whose own check is `node --test`, failing while app.js says BUG. */
function project(name, { dir = "" } = {}) {
  const root = path.join(HOME, name);
  const where = path.join(root, dir);
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(root, "app.js"), "module.exports = 1;\n");
  fs.writeFileSync(
    path.join(where, "app.test.js"),
    [
      'const test = require("node:test");',
      'const assert = require("node:assert");',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `const app = path.join(__dirname, ${JSON.stringify(dir ? "../app.js" : "app.js")});`,
      'test("app.js has no BUG", () => assert.ok(!fs.readFileSync(app, "utf8").includes("BUG")));',
    ].join("\n")
  );
  notePassedCommand({ project: root, line: "node --test", startDir: where, ms: 900 });
  return root;
}

async function turn(root, replies, { checkBeforeDone = true, allow = () => true } = {}) {
  resetShellCwd();
  const session = createSessionState();
  const tools = createToolRegistry({
    cwd: root,
    session,
    signal: new AbortController().signal,
    requestPermission: async (req) => (allow(req) ? { allow: true } : { allow: false, reason: "declined in the test" }),
  });
  const sent = [];
  const notices = [];
  const finals = [];
  const commands = [];
  const transport = {
    name: "api",
    async send(history) {
      sent.push(history[history.length - 1].content);
      return { conversationId: null, content: replies.shift() ?? DONE };
    },
    reset() {},
  };
  const result = await runTurn([said("system", "prompt"), said("user", "change app.js")], {
    transport,
    tools,
    session,
    model: "m",
    maxIterations: 10,
    shellEnabled: true,
    signal: new AbortController().signal,
    cwd: root,
    checkBeforeDone,
    events: {
      onNotice: (text) => notices.push(text),
      onFinal: (text, meta) => finals.push({ text, meta }),
      onToolEnd: (call, res) => {
        if (call.tool === "bash") commands.push({ command: call.arguments.command, error: Boolean(res.error), denied: Boolean(res.denied) });
      },
    },
  });
  return { result, sent, notices, finals, commands };
}

test("a change nothing checked is checked before the turn ends, and a pass ends it", SLOW, async () => {
  const root = project("passes");
  const { result, sent, notices, commands } = await turn(root, [writeApp("module.exports = 2;"), DONE]);
  assert.equal(result.endedBy, "done");
  assert.equal(sent.length, 2, "no extra round trip when the check passes");
  assert.deepEqual(commands, [{ command: "node --test", error: false, denied: false }]);
  assert.ok(notices.some((n) => /checked the work before finishing: `node --test` passed/.test(n)), notices.join(" | "));
});

test("a failure goes back to the model, and the fix is checked again", SLOW, async () => {
  const root = project("fails-then-fixed");
  const { result, sent, notices, commands } = await turn(root, [
    writeApp("module.exports = 'BUG';"),
    DONE,
    writeApp("module.exports = 'fixed';"),
    DONE,
  ]);
  assert.equal(result.endedBy, "done");
  assert.equal(sent.length, 4);
  assert.match(sent[2], /OnFlip ran this project's own check — `node --test`, which passed here before — and it failed/);
  assert.match(sent[2], /app\.js has no BUG/, "the failure itself goes back, not just the fact of it");
  assert.deepEqual(
    commands.map((c) => c.error),
    [true, false],
    "checked once when done came, again after the fix"
  );
  assert.ok(notices.some((n) => /failed — sending the errors back/.test(n)));
});

test("a change the model checked itself is not checked again", SLOW, async () => {
  const root = project("model-checked");
  const { sent, commands } = await turn(root, [
    writeApp("module.exports = 3;"),
    "```onflip\ntool: bash\ncommand: node --test\n```",
    DONE,
  ]);
  assert.equal(sent.length, 3);
  assert.equal(commands.length, 1, "only the model's own run");
});

test("done again without a fix ends the turn, and the user is told it still fails", SLOW, async () => {
  const root = project("still-fails");
  const { result, sent, notices, commands } = await turn(root, [writeApp("module.exports = 'BUG';"), DONE, DONE]);
  assert.equal(result.endedBy, "done");
  assert.equal(sent.length, 3, "sent back once, not in a loop");
  assert.equal(commands.length, 1, "nothing changed, so not run again");
  assert.ok(notices.some((n) => /failed and nothing was changed after it/.test(n)), notices.join(" | "));
});

test("a fix that still fails is checked, and the user is told rather than the model again", SLOW, async () => {
  const root = project("fix-still-fails");
  const { result, sent, notices, commands } = await turn(root, [
    writeApp("module.exports = 'BUG';"),
    DONE,
    writeApp("module.exports = 'BUG again';"),
    DONE,
  ]);
  assert.equal(result.endedBy, "done");
  assert.equal(sent.length, 4, "the failure goes back once");
  assert.deepEqual(commands.map((c) => c.error), [true, true], "the fix was checked too");
  assert.ok(notices.some((n) => /`node --test` still fails/.test(n)), notices.join(" | "));
});

test("the change and the done in one reply are checked the same way", SLOW, async () => {
  const root = project("same-reply");
  const { result, sent, commands } = await turn(root, [
    `${writeApp("module.exports = 'BUG';")}\n\n${DONE}`,
    writeApp("module.exports = 'fixed';"),
    DONE,
  ]);
  assert.equal(result.endedBy, "done");
  // The results and the failure travel together; the done is not called ignored.
  assert.match(sent[1], /<onflip:result tool="write"/);
  assert.match(sent[1], /OnFlip ran this project's own check/);
  assert.doesNotMatch(sent[1], /block in that reply was ignored/);
  assert.deepEqual(commands.map((c) => c.error), [true, false]);
});

test("a package's check runs in its folder and leaves the shell where it was", SLOW, async () => {
  // A monorepo's typecheck in desktop/: it judges a change in desktop/, and
  // it has to run there — this test only passes with desktop/ as its folder.
  const root = path.join(HOME, "subfolder");
  const pkg = path.join(root, "desktop");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "app.js"), "module.exports = 1;\n");
  fs.writeFileSync(
    path.join(pkg, "app.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst fs = require("node:fs");\n' +
      'test("runs in the package", () => assert.ok(fs.existsSync("app.js")));\n'
  );
  notePassedCommand({ project: root, line: "node --test", startDir: pkg, ms: 900 });
  const { commands } = await turn(root, [
    "```onflip\ntool: write\npath: desktop/app.js\ncontent: |\n  module.exports = 4;\n```",
    DONE,
  ]);
  assert.deepEqual(commands, [{ command: "node --test", error: false, denied: false }]);
  assert.equal(getShellCwd(root), root, "the next command must not start in desktop/");
  // A change outside the package is not what its check judges.
  const outside = await turn(root, [writeApp("module.exports = 5;"), DONE]);
  assert.equal(outside.commands.length, 0);
});

test("nothing is run for prose, when switched off, or when declined", SLOW, async () => {
  const root = project("quiet");
  const prose = await turn(root, ["```onflip\ntool: write\npath: README.md\ncontent: |\n  # Notes\n```", DONE]);
  assert.equal(prose.commands.length, 0);
  const off = await turn(root, [writeApp("module.exports = 5;"), DONE], { checkBeforeDone: false });
  assert.equal(off.commands.length, 0);
  const declined = await turn(root, [writeApp("module.exports = 6;"), DONE], { allow: (req) => req.kind !== "command" });
  assert.equal(declined.result.endedBy, "done");
  assert.deepEqual(declined.commands, [{ command: "node --test", error: true, denied: true }]);
  assert.ok(declined.notices.some((n) => /was declined, so the work was not checked/.test(n)));
});
