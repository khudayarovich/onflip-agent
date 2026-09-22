"use strict";

/**
 * A click hands the system only what it cannot run.
 *
 * - The sign-in window passed every address its login pages opened to
 *   `shell.openExternal`, which launches whatever the scheme names: `file:`
 *   runs a program, and a registered handler such as `ms-msdt:` is a way
 *   into the machine from a web page.
 * - "Open" on a file from the chat was `shell.openPath` on it, and a
 *   `.bat`'s or a `.hta`'s default application is running it. The chat's
 *   sandbox can write any file type, so one click was the whole distance
 *   between a reply and executing it. Anything that is not a document,
 *   image, media file or archive is now shown in its folder instead.
 *
 * The rules are tested on the compiled module; the call sites, which live
 * in Electron's main process and cannot be loaded here, are checked in the
 * source the way approval-wiring.test.js checks its own.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "shared", "open-safety.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const load = () => require(DIST);
const source = (name) => fs.readFileSync(path.join(__dirname, "..", "electron", name), "utf8");

test("only web addresses go to the user's browser", { skip: needsBuild }, () => {
  const { isWebUrl } = load();
  for (const url of ["https://help.openai.com/en/", "http://example.com", "HTTPS://CHAT.DEEPSEEK.COM/terms"]) {
    assert.equal(isWebUrl(url), true, url);
  }
  for (const url of [
    "file:///C:/Windows/System32/calc.exe",
    "ms-msdt:/id PCWDiagnostic",
    "search-ms:query=x&crumb=location:\\\\evil\\share",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "vscode://file/c:/x",
    "not a url",
    "",
  ]) {
    assert.equal(isWebUrl(url), false, url);
  }
});

test("documents, images, media and archives open; everything else does not", { skip: needsBuild }, () => {
  const { openableArtifact } = load();
  for (const file of ["report.pdf", "chart.PNG", "C:\\out\\data.xlsx", "/tmp/clip.mp4", "notes.md", "site.zip"]) {
    assert.equal(openableArtifact(file), true, file);
  }
  for (const file of [
    "run.bat", "run.cmd", "setup.ps1", "payload.js", "macro.vbs", "page.hta", "shortcut.lnk",
    "tool.exe", "installer.msi", "screen.scr", "script.py", "build.sh", "start.command",
    "Thing.app", "launcher.desktop", "report.pdf.exe", "README", "",
  ]) {
    assert.equal(openableArtifact(file), false, file);
  }
});

test("the sign-in window's new-window handler checks the scheme", { skip: needsBuild }, () => {
  assert.match(source("signin.ts"), /if \(isWebUrl\(url\)\) void shell\.openExternal\(url\);/);
});

test("so does the main window's", { skip: needsBuild }, () => {
  assert.match(source("main.ts"), /setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(isWebUrl\(url\)\) void shell\.openExternal\(url\);/);
});

test("and Open asks before it launches", { skip: needsBuild }, () => {
  assert.match(
    source("main.ts"),
    /"open-artifact"[\s\S]{0,600}if \(!openableArtifact\(payload\.path\)\) \{\s*shell\.showItemInFolder[\s\S]{0,120}shell\.openPath\(payload\.path\)/
  );
});
