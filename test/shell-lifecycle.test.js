"use strict";

/**
 * When a shell command is over, and what it leaves behind.
 *
 * - A foreground command finished only on "close", which waits for every
 *   holder of its output pipe. A process it started and left running holds
 *   that pipe — `Start-Process -NoNewWindow`, `start /b`, `cmd &` — so the
 *   turn waited for the orphan, and neither the timeout nor Stop could end
 *   it: measured, a 3-second timeout returned at 25.2 seconds.
 * - The probe that reads back the exit code and the directory was appended
 *   to the command's last line with `; `, which broke the shapes a last line
 *   most often has: a here-document (never closed — the probe was written
 *   into the file and exit 0 reported), a trailing `&`, a `# comment`.
 * - Output was one string grown without limit, which throws a little past
 *   half a gigabyte and takes the process with it.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { bashTool, boundedCapture, resetShellCwd, getShellCwd } = require("../dist/tools/shell");

const windows = process.platform === "win32";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-shell-life-"));
  fs.mkdirSync(path.join(dir, "sub"));
  return {
    dir,
    run: (command, extra = {}) =>
      bashTool.run(
        { command, description: "test", ...extra },
        {
          cwd: dir,
          session: { readFiles: new Map(), snapshots: [] },
          requestPermission: async () => ({ allow: true }),
          signal: extra.signal ?? new AbortController().signal,
        }
      ),
  };
}

test("a command that leaves a process holding its output still finishes", async () => {
  const ws = workspace();
  // The orphan lives 20 seconds and prints nothing; the command itself is
  // over as soon as it has started it.
  const command = windows
    ? "Start-Process -NoNewWindow -FilePath node -ArgumentList '-e','setTimeout(()=>{},20000)'; Write-Output launched"
    : "node -e 'setTimeout(()=>{},20000)' & echo launched";
  const started = Date.now();
  const result = await ws.run(command, { timeout_ms: 60_000 });
  const seconds = (Date.now() - started) / 1000;
  assert.match(result.output, /launched/);
  assert.ok(seconds < 15, `returned after ${seconds.toFixed(1)}s — it waited for the orphan`);
});

test("a trailing comment does not swallow the probe", async () => {
  resetShellCwd();
  const ws = workspace();
  await ws.run("cd sub # step into the folder");
  // Compared as the file system names them, not as strings: the shell
  // reports the folder its own way — the long name behind an 8.3 TEMP on
  // the Windows runners, /private/var behind macOS's /var — which is the
  // same folder, and failed every CI run on both.
  const real = (p) => fs.realpathSync.native(p);
  assert.equal(real(getShellCwd(ws.dir)), real(path.join(ws.dir, "sub")));
  resetShellCwd();
});

test("a here-document at the end of a command is closed, not fed the probe", { skip: windows && "PowerShell has no here-documents" }, async () => {
  const ws = workspace();
  const result = await ws.run("cat > notes.md <<'EOF'\n# Notes\nline two\nEOF");
  assert.equal(fs.readFileSync(path.join(ws.dir, "notes.md"), "utf8"), "# Notes\nline two\n");
  assert.match(result.output, /exit code 0/);
});

test("a trailing & runs the command instead of failing to parse", { skip: windows && "PowerShell has no &-jobs of this shape" }, async () => {
  const ws = workspace();
  const result = await ws.run("sleep 1 &");
  assert.match(result.output, /exit code 0/);
});

test("output is kept from both ends, and the cut is said", () => {
  const capture = boundedCapture(50);
  capture.add("HEAD-12345");
  for (let i = 0; i < 1000; i++) capture.add("xxxxxxxxxx");
  capture.add("__ONFLIP_CWD__:0:/end");
  const value = capture.value();
  assert.ok(value.startsWith("HEAD-12345"));
  assert.ok(value.endsWith("__ONFLIP_CWD__:0:/end"), "the probe marker at the end survives");
  assert.match(value, /characters of output were not kept/);
  assert.ok(value.length < 400, `${value.length} characters kept`);
});
