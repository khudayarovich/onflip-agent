"use strict";

/**
 * A forced delete of one named file does not stop a full-auto session.
 *
 * Read from this project's own machine: three times in one session the agent
 * checked its JavaScript by writing the page's script to a temporary file,
 * running `node --check` and removing the file with `Remove-Item … -Force`.
 * A force switch made any delete a "recursive/forced delete", which asks even
 * in full-auto, and the turn sat at the approval prompt for 9, 25 and 14
 * minutes — most of the session, for a second's work each time. A forced
 * delete is judged by what it deletes now; recursion, wildcards, lists,
 * patterns, pipelines, unknown variables and directories still ask.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-forced-delete-"));
const { assessCommand, evaluate } = require("../dist/agent/permissions");

const fullAuto = {
  mode: "full-auto",
  workspace: path.join(os.tmpdir(), "project"),
  allowedCommands: new Set(),
  allowedWriteDirs: new Set(),
  bashRules: {},
};
const verdict = (command) => evaluate(fullAuto, { kind: "command", tool: "bash", subject: command }).outcome;

/** The three commands from the log, as the agent wrote them. */
const FROM_THE_LOG = [
  [
    "$html=Get-Content -Raw index.html",
    "$m=[regex]::Match($html,'(?s)<script>(.*?)</script>')",
    "if(!$m.Success){throw 'Inline script not found'}",
    "$tmp=Join-Path $env:TEMP 'obsidian-chess-check.js'",
    "[IO.File]::WriteAllText($tmp,$m.Groups[1].Value)",
    "node --check $tmp",
    "$code=$LASTEXITCODE",
    "Remove-Item $tmp -Force -ErrorAction SilentlyContinue",
    "if($code -ne 0){exit $code}",
  ].join("\n"),
  [
    "$html = Get-Content -Raw -LiteralPath .\\index.html",
    '$tmp = Join-Path $env:TEMP "obsidian-chess-check.js"',
    "[IO.File]::WriteAllText($tmp, $m.Groups[1].Value)",
    "try { node --check $tmp; $code=$LASTEXITCODE } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }",
    "exit $code",
  ].join("\n"),
  [
    "$script = [regex]::Match($html,'(?s)<script>(.*?)</script>').Groups[1].Value",
    "Set-Content -Path .\\_syntax-check.js -Value $script -NoNewline",
    "node --check .\\_syntax-check.js",
    "$code = $LASTEXITCODE",
    "Remove-Item .\\_syntax-check.js -Force",
    "exit $code",
  ].join("\n"),
];

test("the agent's own syntax checks run in full-auto without a prompt", () => {
  for (const command of FROM_THE_LOG) assert.equal(verdict(command), "allow", command);
});

test("a forced delete of one named file is an ordinary command", () => {
  for (const line of [
    "Remove-Item notes.txt -Force",
    "ri .\\out.js -fo",
    'Remove-Item -LiteralPath "C:\\Users\\x\\AppData\\Local\\Temp\\a.js" -Force -ErrorAction SilentlyContinue',
    "Remove-Item -Path .\\dist\\app.js -Force",
    "$f = New-TemporaryFile; Remove-Item $f -Force",
    "rm -f notes.txt",
    'tmp=$(mktemp); node --check app.js > "$tmp"; rm -f "$tmp"',
  ]) {
    assert.equal(assessCommand(line).dangerous, false, line);
  }
});

test("a forced delete that could be more than one file still asks", () => {
  for (const line of [
    "Remove-Item * -Force",
    "Remove-Item *.log -Force",
    "Remove-Item .\\build\\* -Force",
    "ri -fo .\\a\\[b].js",
    "Remove-Item a.txt, b.txt -Force",
    "Remove-Item a.txt b.txt -Force",
    "Remove-Item -Path . -Filter *.tmp -Force",
    "Remove-Item -Path . -Include *.tmp -Force",
    // The value written inline, so only the pattern check can see it.
    "Remove-Item .\\cache -Filter:*.tmp -Force",
    "Remove-Item .\\logs -Exclude:keep.log -Force",
    "Get-ChildItem *.tmp | Remove-Item -Force",
    "Remove-Item $files -Force",
    "$files = Get-ChildItem -Recurse; Remove-Item $files -Force",
    "$files = @('a','b'); Remove-Item $files -Force",
    "Remove-Item (Get-ChildItem x) -Force",
    "Remove-Item $(Get-ChildItem x) -Force",
    "rm -f *.log",
    "rm -f a b",
    "rm -f $(ls)",
    'rm -f "$x"',
    "rm --force notes.txt build",
  ]) {
    assert.equal(assessCommand(line).dangerous, true, line);
    assert.equal(verdict(line), "ask", line);
  }
});

test("recursion and directories ask whatever else the delete says", () => {
  for (const line of ["Remove-Item -Recurse -Force build", "Remove-Item build -Force -Recurse", "rm -rf build", "rm -fr x", "rm -f -r build"]) {
    assert.deepEqual(assessCommand(line).reasons, ["recursive delete"], line);
  }
  for (const line of ["rd C:\\proj -Force", "rmdir .\\cache -Force"]) {
    assert.ok(assessCommand(line).reasons.includes("forced directory delete"), line);
  }
});
