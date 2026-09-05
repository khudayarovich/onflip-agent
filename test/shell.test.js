"use strict";

/**
 * The shell tool, against the two bugs a real session on another machine
 * turned up.
 *
 * Both were silent. Neither produced an error, an exception, or a warning —
 * the agent was simply told something untrue and spent four turns acting on
 * it, rewriting working code because the machine appeared to disagree with
 * it. That is the expensive shape of bug in this project, and it is worth
 * more tests than a crash would be.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { bashTool, killAllJobs, parseProbe } = require("../dist/tools/shell");

const windows = process.platform === "win32";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-shell-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<title>Fruit Slash</title>");
  fs.writeFileSync(path.join(dir, "game.js"), "function spawn(){}\n");
  return {
    dir,
    run: (command, extra = {}) =>
      bashTool.run(
        { command, description: "test", ...extra },
        {
          cwd: dir,
          session: { readFiles: new Map(), snapshots: [] },
          requestPermission: async () => ({ allow: true }),
          signal: new AbortController().signal,
        }
      ),
  };
}

test.after(() => {
  try {
    killAllJobs();
  } catch {
    /* nothing running */
  }
});

// ---------------------------------------------------------------------------
// object output, which PowerShell defers and `exit` used to discard
// ---------------------------------------------------------------------------

test(
  "a command whose output is objects still produces output",
  { skip: !windows && "PowerShell-specific" },
  async () => {
    // The live symptom: `Get-Item ... | Select-Object Name, Length` came back
    // completely empty, three times, so the agent could not see the files it
    // had just written. `exit` discards PowerShell's pending formatter
    // output, and the formatter is how every object-producing command prints.
    const w = workspace();
    const r = await w.run("Get-Item index.html, game.js | Select-Object Name, Length");
    assert.ok(!r.error, `should have succeeded: ${r.output}`);
    assert.match(r.output, /index\.html/, `no table in output:\n${r.output}`);
    assert.match(r.output, /game\.js/);
    assert.match(r.output, /Length/, "the formatted header should be present");
  }
);

test(
  "plain string output is unaffected",
  { skip: !windows && "PowerShell-specific" },
  async () => {
    const w = workspace();
    const r = await w.run("Write-Output 'plain'");
    assert.ok(!r.error);
    assert.match(r.output, /plain/);
  }
);

test("a failing command is still reported as a failure", async () => {
  // The exit code now travels in the marker rather than through `exit`, and
  // this is the property that must not have been traded away for the output.
  const w = workspace();
  const r = await w.run(windows ? "Get-Item definitely-not-here.txt" : "ls definitely-not-here.txt");
  assert.equal(r.error, true, `should have failed:\n${r.output}`);
});

test("a native program's own exit code survives", async () => {
  const w = workspace();
  const r = await w.run(windows ? "cmd /c exit 3" : "sh -c 'exit 3'");
  assert.equal(r.error, true);
  assert.match(r.output, /exit code 3/);
});

test("a successful command is not reported as a failure", async () => {
  const w = workspace();
  const r = await w.run("node --version");
  assert.ok(!r.error, `should have succeeded:\n${r.output}`);
  assert.match(r.output, /v\d+/);
});

test("the working directory is still tracked through the marker", async () => {
  // The marker carries the exit code *and* the path now, and a Windows path
  // is full of colons — only the first one separates them.
  const w = workspace();
  const r = await w.run(windows ? "Get-Location | Out-String" : "pwd");
  assert.ok(!r.error);
  assert.ok(!r.output.includes("__ONFLIP_CWD__"), "the marker must not leak into the output");
});

// ---------------------------------------------------------------------------
// the probe line, on both platforms
//
// Only one of these shells can be run from any given machine, and the two
// shapes differ in exactly the way that is easy to get wrong: a Windows path
// is full of colons and a POSIX one is not. So the parser is pure and both
// are checked from anywhere.
// ---------------------------------------------------------------------------

test("a Windows probe keeps the drive letter in the path", () => {
  const r = parseProbe("hello\n__ONFLIP_CWD__:0:C:\\Users\\me\\project\n");
  assert.equal(r.code, 0);
  assert.equal(r.cwd, "C:\\Users\\me\\project", "the path must not be cut at the drive colon");
  assert.equal(r.stdout.trim(), "hello");
});

test("a macOS or Linux probe parses the same way", () => {
  const r = parseProbe("hello\n__ONFLIP_CWD__:0:/Users/me/project\n");
  assert.equal(r.code, 0);
  assert.equal(r.cwd, "/Users/me/project");
  assert.equal(r.stdout.trim(), "hello");
});

test("a non-zero code comes back from either platform's probe", () => {
  assert.equal(parseProbe("__ONFLIP_CWD__:3:C:\\tmp").code, 3);
  assert.equal(parseProbe("__ONFLIP_CWD__:127:/tmp").code, 127);
});

test("no probe at all leaves the process exit code in charge", () => {
  // A command that calls `exit` itself kills the shell before the probe can
  // run. There is then no marker, and the process code is the only truth.
  const r = parseProbe("partial output\n");
  assert.equal(r.code, null);
  assert.equal(r.cwd, null);
  assert.equal(r.stdout.trim(), "partial output");
});

test("output with no trailing newline keeps its text", () => {
  // The marker shares that last line, so only the marker may be removed.
  const r = parseProbe("no newline here__ONFLIP_CWD__:0:/tmp");
  assert.equal(r.stdout, "no newline here");
  assert.equal(r.cwd, "/tmp");
});

test("a path containing spaces survives", () => {
  const r = parseProbe("__ONFLIP_CWD__:0:/Users/me/My Project");
  assert.equal(r.cwd, "/Users/me/My Project");
});

test("the marker never leaks into the output", () => {
  for (const line of [
    "__ONFLIP_CWD__:0:/tmp",
    "text__ONFLIP_CWD__:0:C:\\x",
    "a\nb\n__ONFLIP_CWD__:1:/var",
  ]) {
    assert.ok(!parseProbe(line).stdout.includes("__ONFLIP_CWD__"), `leaked for: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// background jobs that never started
// ---------------------------------------------------------------------------

test("a background command that cannot start says so", async () => {
  // Live: `python -m http.server 8000` on a machine with no python was
  // reported as "Started in the background as job_1". Every check the agent
  // then ran was correct, and the only wrong thing it had been told was that
  // line — four turns and several rewrites chasing a server that never was.
  const w = workspace();
  const r = await w.run("definitelynotarealprogram-xyz --serve", { background: true });
  assert.equal(r.error, true, `should have reported the failure:\n${r.output}`);
  assert.match(r.output, /did not stay running/);
  assert.ok(!/Started in the background/.test(r.output), "it must not claim to have started");
});

test("a background command that finishes at once says that too", async () => {
  // Exiting 0 immediately is not a failure, but "started in the background"
  // would be just as untrue about it.
  const w = workspace();
  const r = await w.run(windows ? "Write-Output hello" : "echo hello", { background: true });
  assert.ok(!r.error, `should not be an error:\n${r.output}`);
  assert.match(r.output, /finished immediately/);
  assert.match(r.output, /hello/);
});

test("a real long-running command is still reported as started", async () => {
  // The check must not cost the feature it is protecting.
  const w = workspace();
  const port = 8730 + Math.floor(Math.random() * 40);
  const server = `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')`;
  const r = await w.run(`node -e "${server}"`, { background: true });
  assert.ok(!r.error, `a real server should start:\n${r.output}`);
  assert.match(r.output, /Started in the background as job_/);

  const body = await fetch(`http://127.0.0.1:${port}/`)
    .then((x) => x.text())
    .catch((e) => `FAILED: ${e.message}`);
  assert.equal(body, "ok", "the server it reported as started should actually answer");
});
