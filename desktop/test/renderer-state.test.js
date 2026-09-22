"use strict";

/**
 * What the window shows, and what it keeps while showing it.
 *
 * - A path with `$&` in it came out of a translated string with the
 *   placeholder pasted into the middle — "Saved to C:\shots\a{path}b.png" —
 *   because String.replace expands `$&` and `$'` in a replacement string.
 * - Reopening an older project from "Recent projects" left it out of the
 *   sidebar: group positions are fixed at first render and only eight are
 *   shown, so the project in use was ninth, and cut.
 * - The docked browser is a native view drawn above the page. The session
 *   preview and the update dialog were not among the layers that take it off
 *   screen, so on common window widths it covered their buttons.
 * - The Telegram settings refreshed on every bot status change and wrote the
 *   saved IDs over the ones being typed: the check read a `dirty` flag frozen
 *   at the first render.
 * - The approval prompt's heading and request kind, and every confirmation
 *   the window asks, were English whatever language the app was set to.
 *
 * Where it can, this runs the real renderer, bundled with the esbuild Vite
 * already brings and rendered with react-dom/server. Call sites in
 * components that need a live window are checked in the source.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const DESKTOP = path.join(__dirname, "..");
const UI = path.join(DESKTOP, "ui", "src");
const needsBuild = ["esbuild", "react", "react-dom"].every((dep) =>
  fs.existsSync(path.join(DESKTOP, "node_modules", dep, "package.json"))
)
  ? false
  : "desktop dependencies are not installed (run: cd desktop && npm install)";

let bundled = null;
function renderer() {
  if (bundled) return bundled;
  // The sidebar reads the preload bridge in a few branches; none of them runs
  // in these renders, but a module that touches it on load must not throw.
  globalThis.window = globalThis.window ?? { onflip: {} };
  const esbuild = require(path.join(DESKTOP, "node_modules", "esbuild"));
  const out = esbuild.buildSync({
    stdin: {
      contents: [
        'import React from "react";',
        'import { renderToStaticMarkup } from "react-dom/server";',
        'import { translate, LangContext } from "./i18n";',
        'import { Sidebar } from "./components/Sidebar";',
        'import { ApprovalModal } from "./components/ApprovalModal";',
        "export { translate };",
        "export const sidebar = (props) => renderToStaticMarkup(React.createElement(Sidebar, props));",
        "export const approval = (lang, props) =>",
        "  renderToStaticMarkup(React.createElement(LangContext.Provider, { value: lang }, React.createElement(ApprovalModal, props)));",
      ].join("\n"),
      resolveDir: UI,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    nodePaths: [path.join(DESKTOP, "node_modules")],
    loader: { ".svg": "text", ".css": "empty", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const mod = new Module(path.join(UI, "renderer-state.bundle.cjs"));
  mod.filename = mod.id;
  mod.paths = Module._nodeModulePaths(DESKTOP);
  mod._compile(out.outputFiles[0].text, mod.filename);
  bundled = mod.exports;
  return bundled;
}

test("a value is put into a translation as written", { skip: needsBuild }, () => {
  const { translate } = renderer();
  assert.equal(translate("en", "imageSaved", { path: "C:\\shots\\a$&b.png" }), "Saved to C:\\shots\\a$&b.png");
  assert.equal(translate("en", "imageSaved", { path: "/tmp/it$'s.png" }), "Saved to /tmp/it$'s.png");
  // The false-positive half: ordinary values, and numbers, still substitute.
  assert.equal(translate("en", "imageSaved", { path: "C:\\shots\\a.png" }), "Saved to C:\\shots\\a.png");
  assert.equal(translate("en", "scheduleRunsIn", { project: "onflip" }), "Runs in onflip");
});

const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
const noop = () => {};

/** The project names the sidebar lists, in order. */
function listed(cwd) {
  const { sidebar } = renderer();
  const sessions = NAMES.map((name, i) => ({
    id: `s${i}`,
    title: `a chat in ${name}`,
    cwd: `C:\\work\\${name}`,
    model: "gpt",
    // Newest first, the order the store lists them in.
    updatedAt: 10_000 - i,
    messageCount: 2,
  }));
  const html = sidebar({
    status: cwd ? { version: "0", cwd, home: "C:\\Users\\me" } : null,
    connect: "ready",
    sessions,
    projects: [],
    resumingId: null,
    switching: false,
    workingId: null,
    failedId: null,
    onNewSession: noop,
    onResumeSession: noop,
    onDeleteSession: noop,
    onOpenProject: noop,
    onPickFolder: noop,
    onNewScratchChat: noop,
    onOpenSettings: noop,
    onOpenAbout: noop,
    onOpenSkills: noop,
    onOpenHealth: noop,
    onOpenSchedules: noop,
    onOpenSubTasks: noop,
    onSignIn: noop,
    onSignOut: noop,
  });
  return [...html.matchAll(/class="group-name">([^<]*)</g)].map((m) => m[1]);
}

test("the project in use is listed even when it is the ninth", { skip: needsBuild }, () => {
  const shown = listed("C:\\work\\india");
  assert.ok(shown.includes("india"), `the open project is in the list: ${shown.join(", ")}`);
  assert.equal(shown.length, 8, "still eight, not nine");
  assert.deepEqual(shown.slice(0, 7), NAMES.slice(0, 7), "and the rest keep their places");
});

test("and a list that already shows it is left as it was", { skip: needsBuild }, () => {
  // The false-positive half.
  assert.deepEqual(listed("C:\\work\\charlie"), NAMES.slice(0, 8));
  assert.deepEqual(listed("C:\\Users\\me"), NAMES.slice(0, 8), "a loose chat is not a project");
  assert.deepEqual(listed(null), NAMES.slice(0, 8), "nor is a window still connecting");
});

test("every dialog takes the docked browser off screen", { skip: needsBuild }, () => {
  const app = fs.readFileSync(path.join(UI, "App.tsx"), "utf8");
  const covered = /covered=\{([^}]*)\}/.exec(app);
  assert.ok(covered, "the browser panel is told when it is covered");
  for (const layer of ["modal", "approval", "confirm", "peek", "updateRun"]) {
    assert.match(covered[1], new RegExp(`\\b${layer} !== null`), `${layer} covers the view`);
  }
  // Every dialog App renders is one of those. A new one added without
  // joining the list is caught here: a component named *Modal, or a
  // hand-built backdrop like the update dialog's.
  const dialogs = [...app.matchAll(/\{(\w+) && \(\s*<(?:\w*Modal\b|div className="[\w-]*modal-backdrop")/g)];
  const states = dialogs.map((m) => m[1]);
  for (const state of ["approval", "peek", "confirm", "updateRun"]) {
    assert.ok(states.includes(state), `the scan finds the ${state} dialog (found: ${states.join(", ")})`);
  }
  for (const state of states) {
    assert.match(covered[1], new RegExp(`\\b${state} !== null`), `${state} opens a dialog the view would cover`);
  }
  assert.match(app, /\{modal === "settings" && \(/, "the rest hang off `modal`, which is in the list");
});

test("the Telegram IDs being typed survive a status refresh", { skip: needsBuild }, () => {
  const settings = fs.readFileSync(path.join(UI, "components", "SettingsModal.tsx"), "utf8");
  const section = settings.slice(settings.indexOf("function TelegramSection("));
  const refresh = section.slice(section.indexOf("const refresh = () =>"), section.indexOf("useEffect("));
  assert.match(refresh, /if \(!dirtyRef\.current\) setIds\(next\.allowedIds\);/, "refresh reads the live flag");
  assert.doesNotMatch(refresh, /if \(!dirty\)/, "not the one frozen at the first render");
  assert.match(section, /const setDirty = \(value: boolean\) => \{\s*dirtyRef\.current = value;\s*setDirtyState\(value\);/);
});

test("the approval prompt speaks the app's language", { skip: needsBuild }, () => {
  // Its heading and the kind of request were English in every language,
  // on the one dialog that decides whether a command runs.
  const { approval } = renderer();
  const request = { kind: "command", tool: "bash", subject: "npm run build", reason: "runs a command", dangerous: false };
  const ru = approval("ru", { request, onDecision: () => {} });
  assert.match(ru, /Нужно подтверждение/);
  assert.match(ru, /Команда шелла/);
  assert.doesNotMatch(ru, /Approval needed|Shell command/);
  const uz = approval("uz", { request: { ...request, kind: "write" }, onDecision: () => {} });
  assert.match(uz, /Tasdiq kerak/);
  assert.match(uz, /Faylga yozish/);
  // The false-positive half: English stays English.
  assert.match(approval("en", { request, onDecision: () => {} }), /Approval needed[\s\S]*Shell command/);
});

test("every confirmation is asked in the app's language", { skip: needsBuild }, () => {
  const { translate } = renderer();
  const keys = [
    "approvalNeeded", "kindRead", "kindWrite", "kindCommand", "kindNetwork",
    "confirmTitle", "editEarlierConfirm", "undoRevertConfirm", "undoDeleteConfirm", "yoloConfirm",
  ];
  for (const key of keys) {
    const en = translate("en", key);
    assert.notEqual(en, key, `${key} has English text`);
    for (const lang of ["ru", "uz"]) {
      assert.notEqual(translate(lang, key), en, `${key} is translated for ${lang}`);
    }
  }
  assert.equal(translate("ru", "undoDeleteConfirm", { file: "app.ts" }), "Удалить app.ts? До этой сессии его не было.");
  // And no confirmation in the window is a bare English literal any more.
  const app = fs.readFileSync(path.join(UI, "App.tsx"), "utf8");
  const messages = [...app.matchAll(/setConfirm\(\{\s*message:\s*([^\n]+)/g)].map((m) => m[1].trim());
  assert.ok(messages.length >= 5, `found ${messages.length} confirmations`);
  for (const message of messages) {
    assert.match(message, /^(?:t|translate)\(/, `an untranslated confirmation: ${message}`);
  }
  assert.match(app, /title=\{t\("confirmTitle"\)\}/);
});
