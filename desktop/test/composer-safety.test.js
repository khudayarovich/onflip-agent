"use strict";

/**
 * What the composer does with what the person typed.
 *
 * - A message sent while the engine was still connecting was refused, and
 *   the composer had already cleared: the words vanished behind an error.
 * - Escape in the composer stopped the running turn even with a dialog open
 *   over it — and, having claimed the key, left the dialog open.
 * - Edit and Resend brought back the words without the files, and with
 *   OnFlip's "[Attached to this message: …]" note in them as if typed.
 *
 * The renderer is bundled and has no harness that can press keys in it, so
 * its call sites are checked in the source; the rules they call, and the
 * engine half, are tested for real.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ESCAPE = path.join(__dirname, "..", "dist", "shared", "escape.js");
const REPLAY = path.join(__dirname, "..", "dist", "engine", "replay.js");
const needsBuild = fs.existsSync(ESCAPE) && fs.existsSync(REPLAY)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const ui = (name) => fs.readFileSync(path.join(__dirname, "..", "ui", "src", name), "utf8");

test("Escape stops a turn only when nothing is open above the composer", { skip: needsBuild }, () => {
  const { escapeInterrupts } = require(ESCAPE);
  const esc = { key: "Escape", defaultPrevented: false };
  assert.equal(escapeInterrupts(esc, true, false), true, "the ordinary case still stops");
  assert.equal(escapeInterrupts(esc, true, true), false, "a dialog or menu takes the key");
  assert.equal(escapeInterrupts({ ...esc, defaultPrevented: true }, true, false), false, "a claimed key stays claimed");
  assert.equal(escapeInterrupts(esc, false, false), false, "nothing to stop");
  assert.equal(escapeInterrupts({ key: "Enter", defaultPrevented: false }, true, false), false);
});

test("and the composer asks it, with the backdrops the layers really use", { skip: needsBuild }, () => {
  const { LAYER_QUERY } = require(ESCAPE);
  const composer = ui(path.join("components", "Composer.tsx"));
  assert.match(composer, /if \(escapeInterrupts\(e, busy, Boolean\(document\.querySelector\(LAYER_QUERY\)\)\)\)/);
  assert.doesNotMatch(composer, /e\.key === "Escape" && busy\)/, "the unconditional check is gone");
  const layers = [
    ui(path.join("components", "common.tsx")),
    ui(path.join("components", "ApprovalModal.tsx")),
    ui(path.join("components", "Sidebar.tsx")),
    ui("App.tsx"),
  ];
  for (const cls of LAYER_QUERY.split(",").map((s) => s.trim().slice(1))) {
    assert.ok(layers.some((source) => source.includes(`"${cls}"`)), `${cls} is a class a layer renders`);
  }
});

test("and every backdrop the window renders is one of them", { skip: needsBuild }, () => {
  // The update dialog built its own backdrop, so Escape in the composer
  // still stopped the turn underneath it.
  const { LAYER_QUERY } = require(ESCAPE);
  const listed = LAYER_QUERY.split(",").map((s) => s.trim().slice(1));
  // Not a layer: the highlight drawn behind the composer's own text, there
  // whenever the composer is. Listing it would mean Escape never stops a turn.
  const behindText = new Set(["input-backdrop"]);
  const dir = path.join(__dirname, "..", "ui", "src");
  const files = ["App.tsx", ...fs.readdirSync(path.join(dir, "components")).map((f) => path.join("components", f))];
  let found = 0;
  for (const file of files.filter((f) => f.endsWith(".tsx"))) {
    for (const [, cls] of ui(file).matchAll(/className="([\w-]*backdrop)"/g)) {
      found++;
      if (behindText.has(cls)) continue;
      assert.ok(listed.includes(cls), `${file} renders .${cls}, which Escape does not know is a layer`);
    }
  }
  assert.ok(found >= 5, `the scan still finds the backdrops (${found})`);
  assert.ok(!listed.some((cls) => behindText.has(cls)), "the composer's own highlight is not a layer");
});

test("the account popover closes on Escape, like every other menu", { skip: needsBuild }, () => {
  const sidebar = ui(path.join("components", "Sidebar.tsx"));
  const bar = sidebar.slice(sidebar.indexOf("function AccountBar("));
  assert.match(
    bar,
    /if \(!open\) return;\s*const onKey = \(e: KeyboardEvent\) => \{\s*if \(e\.key === "Escape" && !e\.defaultPrevented\) setOpen\(false\);/
  );
});

test("a send the engine refuses puts the message back", { skip: needsBuild }, () => {
  const app = ui("App.tsx");
  const send = app.slice(app.indexOf("const sendPrompt = useCallback("), app.indexOf("const loadModels"));
  assert.match(send, /api\.send\(text, attachments\?\.length \? attachments : undefined\)\.catch\(/);
  assert.match(send, /setDraft\(\{ text, files: attachments, nonce: Date\.now\(\) \}\)/);
});

test("edit and resend carry the files", { skip: needsBuild }, () => {
  const app = ui("App.tsx");
  assert.match(app, /setDraft\(\{ text: r\.text, files: r\.attachments, nonce: Date\.now\(\) \}\)/);
  assert.match(app, /sendPrompt\(r\.text, r\.attachments\)/);
});

test("a replayed message shows its files, and none of OnFlip's notes", { skip: needsBuild }, () => {
  const { replayItems, stripUserNotes } = require(REPLAY);
  const content =
    "look at these\n\n[The user referenced these paths: src/app.ts. Read them before answering.]" +
    "\n\n[Attached to this message: shot.png, spec.pdf]";
  assert.equal(stripUserNotes(content), "look at these");
  assert.equal(
    stripUserNotes("x\n\n[These files were named but not uploaded, because this plan rations uploads. Read them from disk if you need them: C:\\a.png]"),
    "x"
  );
  // The false-positive half: brackets the person typed are theirs.
  assert.equal(stripUserNotes("keep [this] and\n\n[that]"), "keep [this] and\n\n[that]");

  const items = replayItems([
    { id: "s", role: "system", content: "sys" },
    { id: "u1", role: "user", content, attachments: ["C:\\shots\\shot.png", "C:\\docs\\spec.pdf"] },
  ]);
  const user = items.find((i) => i.type === "user");
  assert.deepEqual(
    { text: user.text, attachments: user.attachments },
    { text: "look at these", attachments: ["C:\\shots\\shot.png", "C:\\docs\\spec.pdf"] }
  );
});
