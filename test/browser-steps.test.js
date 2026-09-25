"use strict";

/**
 * Fewer round trips through the agent's browser.
 *
 * Every browser action already answers with a fresh snapshot of the page,
 * and models asked for another one straight afterwards anyway — a round
 * trip and up to six thousand characters of a page they had just been
 * shown. And a form of five fields was five calls, five approvals and five
 * full snapshots. `browser_snapshot` now answers an unchanged page in a
 * line, and `browser_type` takes a `fields` list.
 *
 * Nothing here launches a browser. Playwright is replaced in the module
 * cache under the key the tool resolves it by, and the page is a fake whose
 * snapshot the test writes.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-browser-steps-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_BROWSER_HEADLESS = "1";
delete process.env.ONFLIP_EMBEDDED_CDP;
delete process.env.ONFLIP_EMBEDDED_MARK;

/** What the page's snapshot program returns; each test sets it. */
let shot;
/** Input types by ref, for the password mask. */
let types = {};
/** Everything typed, pressed and clicked, in order. */
let typed = [];
/** A ref whose fill throws. */
let failOn = null;

const fakePage = {
  closed: false,
  /** The page's own events — `pageerror` and `console` — by name. */
  handlers: {},
  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  },
  emit(event, value) {
    for (const fn of this.handlers[event] ?? []) fn(value);
  },
  isClosed() {
    return this.closed;
  },
  setDefaultTimeout() {},
  async evaluate() {
    return JSON.parse(JSON.stringify(shot));
  },
  url() {
    return shot.url;
  },
  async title() {
    return shot.title;
  },
  locator(selector) {
    const ref = /data-onflip-ref="([^"]+)"/.exec(selector)?.[1];
    const exists = shot.elements.some((e) => e.ref === ref);
    return {
      async count() {
        return exists ? 1 : 0;
      },
      async getAttribute(name) {
        return name === "type" ? (types[ref] ?? null) : null;
      },
      async fill(text) {
        if (ref === failOn) throw new Error("element is not editable");
        typed.push([ref, text]);
      },
      async press(key) {
        typed.push(["press", ref, key]);
      },
      async click() {
        typed.push(["click", ref]);
      },
    };
  },
  async waitForLoadState() {},
  async waitForTimeout() {},
  async goto() {
    onGoto?.();
  },
  mainFrame() {
    return mainFrame;
  },
};
/** The page's main frame, for `framenavigated`. */
const mainFrame = { name: "main" };
/** What happens between a navigation starting and ending; a test sets it. */
let onGoto = null;
const fakeContext = {
  pages: () => [fakePage],
  async newPage() {
    return fakePage;
  },
  async close() {
    fakePage.closed = true;
  },
};
fakePage.context = () => fakeContext;
const fakePlaywright = {
  chromium: {
    async launchPersistentContext() {
      fakePage.closed = false;
      return fakeContext;
    },
  },
};
const playwrightKey = require.resolve("playwright");
require.cache[playwrightKey] = { id: playwrightKey, filename: playwrightKey, loaded: true, exports: fakePlaywright };

const { closeAutomationBrowser, SNAPSHOT } = require("../dist/tools/browser");
const { createToolRegistry } = require("../dist/tools/index");
const { loggableArguments } = require("../dist/agent/run");
const { parseTurn } = require("../dist/agent/protocol");

const signup = (over = {}) => ({
  url: "https://example.test/signup",
  title: "Sign up",
  elements: [
    { ref: "ref_1", role: "textbox", name: "Name" },
    { ref: "ref_2", role: "textbox", name: "Email" },
    { ref: "ref_3", role: "textbox", name: "Password" },
    { ref: "ref_4", role: "button", name: "Create account" },
  ],
  hidden: 0,
  text: "Create your account",
  ...over,
});

let asked = [];
const reg = createToolRegistry({
  cwd: HOME,
  session: { todos: [], snapshots: [], readFiles: new Map(), fullReads: new Map() },
  signal: new AbortController().signal,
  requestPermission: async (req) => {
    asked.push(req);
    return { allow: true };
  },
});

async function onSignup() {
  shot = signup();
  types = { ref_3: "password" };
  failOn = null;
  await reg.run("browser_open", { url: "https://example.test/signup" });
  asked = [];
  typed = [];
}

test.after(() => closeAutomationBrowser());

test("the stub is what the tool got", async () => {
  await onSignup();
  assert.equal(fakePage.closed, false);
  // The page is watched from its first open — and that open succeeded: a
  // listener that could not be attached used to fail it silently, and every
  // later call went through on the page it had left behind.
  assert.equal(fakePage.handlers.pageerror?.length, 1);
  assert.equal(fakePage.handlers.console?.length, 1);
});

// ---------------------------------------------------------------------------
// a form in one call
// ---------------------------------------------------------------------------

test("a form is filled in one call: one approval, one snapshot, Enter in the last field", async () => {
  await onSignup();
  const result = await reg.run("browser_type", {
    fields: [
      { ref: "ref_1", text: "Jane" },
      { ref: "ref_2", text: "jane@example.test" },
      { ref: "ref_3", text: "hunter22" },
    ],
    submit: true,
  });
  assert.equal(result.error, undefined, result.output);
  assert.deepEqual(typed, [
    ["ref_1", "Jane"],
    ["ref_2", "jane@example.test"],
    ["ref_3", "hunter22"],
    ["press", "ref_3", "Enter"],
  ]);
  assert.equal(asked.length, 1, "one approval for the whole form");
  assert.equal(asked[0].subject, "fill 3 fields: ref_1, ref_2, ref_3");
  assert.deepEqual(asked[0].detail, [
    "ref_1: Jane",
    "ref_2: jane@example.test",
    "ref_3: ••••••••",
    "page: https://example.test/signup",
    "and press Enter",
  ]);
  assert.ok(!JSON.stringify(asked).includes("hunter22"), "the password is not put on screen");
  assert.match(result.output, /^Filled ref_1, ref_2, ref_3, and pressed Enter in ref_3\.\n/);
  assert.match(result.output, /interactive elements \(act on these by ref\):/, "one snapshot, at the end");
});

test("the block form's list arrives as the fields", async () => {
  await onSignup();
  const fence = "`".repeat(3);
  const reply = [
    `${fence}onflip`,
    "tool: browser_type",
    "fields:",
    "  - ref: ref_1",
    "    text: Jane",
    "  - ref: ref_2",
    "    text: jane@example.test",
    fence,
  ].join("\n");
  const [call] = parseTurn(reply, (name) => !!reg.get(name)).calls;
  const result = await reg.run(call.tool, call.arguments);
  assert.equal(result.error, undefined, result.output);
  assert.deepEqual(typed, [
    ["ref_1", "Jane"],
    ["ref_2", "jane@example.test"],
  ]);
});

test("a stale ref anywhere in the form stops it before anything is typed", async () => {
  await onSignup();
  const result = await reg.run("browser_type", {
    fields: [
      { ref: "ref_1", text: "Jane" },
      { ref: "ref_9", text: "x" },
    ],
  });
  assert.equal(result.error, true);
  assert.match(result.output, /ref_9 is not on the page/);
  assert.deepEqual(typed, [], "nothing typed");
  assert.deepEqual(asked, [], "and nothing asked");
});

test("a field that fails says which ones went in", async () => {
  await onSignup();
  failOn = "ref_2";
  const result = await reg.run("browser_type", {
    fields: [
      { ref: "ref_1", text: "Jane" },
      { ref: "ref_2", text: "jane@example.test" },
      { ref: "ref_3", text: "hunter22" },
    ],
  });
  assert.equal(result.error, true);
  assert.equal(
    result.output,
    "Could not type into ref_2: element is not editable. ref_1 was filled before it; the rest were not."
  );
  assert.deepEqual(typed, [["ref_1", "Jane"]]);
});

test("a malformed or oversized list is refused with the shape it needs", async () => {
  await onSignup();
  const missing = await reg.run("browser_type", { fields: [{ ref: "ref_1" }] });
  assert.equal(missing.error, true);
  assert.match(missing.output, /`fields` entry 1 needs a ref and a text/);
  const many = Array.from({ length: 21 }, (_, i) => ({ ref: "ref_1", text: String(i) }));
  const tooMany = await reg.run("browser_type", { fields: many });
  assert.equal(tooMany.error, true);
  assert.match(tooMany.output, /holds 21 entries; send at most 20/);
  assert.deepEqual(typed, []);
});

test("one field is typed exactly as before", async () => {
  await onSignup();
  const result = await reg.run("browser_type", { ref: "ref_1", text: "Jane", submit: true });
  assert.equal(result.error, undefined);
  assert.deepEqual(typed, [
    ["ref_1", "Jane"],
    ["press", "ref_1", "Enter"],
  ]);
  assert.equal(asked[0].subject, "type into ref_1: Jane");
  assert.deepEqual(asked[0].detail, ["page: https://example.test/signup", "and press Enter"]);
  assert.match(result.output, /^Typed into ref_1 and pressed Enter\.\n/);
  const password = await reg.run("browser_type", { ref: "ref_3", text: "hunter22" });
  assert.equal(password.error, undefined);
  assert.equal(asked[1].subject, "type into ref_3: ••••••••");
});

test("a form's typed text is never written to the log", () => {
  const out = loggableArguments({
    tool: "browser_type",
    arguments: {
      fields: [
        { ref: "ref_1", text: "Jane" },
        { ref: "ref_3", text: "hunter22" },
      ],
    },
  });
  assert.deepEqual(out.fields, [
    { ref: "ref_1", text: "<redacted 4 chars>" },
    { ref: "ref_3", text: "<redacted 8 chars>" },
  ]);
  // Still the text of a JSON array at the point it is logged.
  const raw = loggableArguments({
    tool: "browser_type",
    arguments: { fields: '[{"ref":"ref_3","text":"hunter22"}]' },
  });
  assert.ok(!JSON.stringify(raw).includes("hunter22"));
  const junk = loggableArguments({ tool: "browser_type", arguments: { fields: "ref_3 hunter22" } });
  assert.equal(junk.fields, "<redacted 14 chars>");
});

// ---------------------------------------------------------------------------
// a snapshot nobody needed
// ---------------------------------------------------------------------------

test("a snapshot straight after an action is answered in a line when nothing changed", async () => {
  await onSignup();
  const clicked = await reg.run("browser_click", { ref: "ref_4" });
  assert.match(clicked.output, /interactive elements \(act on these by ref\):/);
  const again = await reg.run("browser_snapshot", {});
  assert.equal(again.error, undefined);
  assert.match(
    again.output,
    /^Nothing has changed since the snapshot \d+s ago: the same page, the same 4 interactive elements under the same refs/
  );
  assert.ok(again.output.length < 300, "a line, not the page");
  // Asked again after being told: it has a reason to want the page itself.
  const third = await reg.run("browser_snapshot", {});
  assert.match(third.output, /interactive elements \(act on these by ref\):/);
});

test("a page that changed is always shown whole", async () => {
  await onSignup();
  await reg.run("browser_click", { ref: "ref_4" });
  shot = signup({ text: "Check your inbox" });
  const after = await reg.run("browser_snapshot", {});
  assert.match(after.output, /page text:\nCheck your inbox/);
});

test("an older snapshot is not vouched for: it may have been trimmed from the conversation", async () => {
  await onSignup();
  await reg.run("browser_click", { ref: "ref_4" });
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    const later = await reg.run("browser_snapshot", {});
    assert.match(later.output, /interactive elements \(act on these by ref\):/);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// what the snapshot tells the model's service
// ---------------------------------------------------------------------------

/** The in-page snapshot program, run against a hand-built document. */
function runSnapshot(fields) {
  const attrs = (el) => el.attrs;
  const elements = fields.map((f) => ({
    tagName: f.tag || "INPUT",
    attrs: { ...(f.type ? { type: f.type } : {}), ...(f.attrs || {}) },
    value: f.value,
    innerText: f.innerText || "",
    disabled: false,
    checked: false,
    getAttribute(name) {
      return name in attrs(this) ? attrs(this)[name] : null;
    },
    setAttribute(name, value) {
      attrs(this)[name] = value;
    },
    removeAttribute(name) {
      delete attrs(this)[name];
    },
    getBoundingClientRect: () => ({ width: 120, height: 24 }),
  }));
  const document = {
    title: "Sign in",
    body: { innerText: "Sign in to continue" },
    getElementById: () => null,
    querySelectorAll: (selector) =>
      selector === "[data-onflip-ref]" ? elements.filter((e) => "data-onflip-ref" in e.attrs) : elements,
  };
  const window = { getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
  const location = { href: "https://example.test/login" };
  return new Function("document", "window", "location", `return (${SNAPSHOT})(120);`)(document, window, location);
}

test("a password in a field never leaves the page, whoever typed it", () => {
  // The person signing in through the browser panel, or the profile
  // autofilling, puts a password in a field the model never typed — and
  // every snapshot after it went to the model's service with the password
  // in the clear.
  const shot = runSnapshot([
    { type: "email", value: "jane@example.test", attrs: { placeholder: "Email" } },
    { type: "password", value: "hunter22", attrs: { placeholder: "Password" } },
    { type: "PASSWORD", value: "correct horse battery staple" },
  ]);
  assert.ok(!JSON.stringify(shot).includes("hunter22"), "the typed password is not in the snapshot");
  assert.ok(!JSON.stringify(shot).includes("correct horse"), "nor one in a field with no label to name it by");
  const [email, password, unlabelled] = shot.elements;
  assert.equal(email.value, "jane@example.test", "an ordinary field still reads as typed");
  assert.equal(password.role, "password");
  assert.equal(password.value, "••••••••", "filled, and how long, is what the model needs");
  assert.equal(password.name, "Password");
  assert.equal(unlabelled.name, "", "its value is not used as its name either");
  assert.equal(unlabelled.value, "••••••••••••", "capped, like the approval prompt's mask");
});

test("and the snapshot the model reads says the field is filled without saying with what", () => {
  const shot = runSnapshot([{ type: "password", value: "hunter22", attrs: { "aria-label": "Password" } }]);
  assert.equal(shot.elements[0].value, "••••••••");
  const empty = runSnapshot([{ type: "password", value: "", attrs: { "aria-label": "Password" } }]);
  assert.equal(empty.elements[0].value, "", "an empty field still reads as empty");
});

// ---------------------------------------------------------------------------
// the page's console, for a page the agent built
// ---------------------------------------------------------------------------

/** A page on this machine's own server, the kind the agent builds and checks. */
const devPage = () => ({
  url: "http://localhost:5173/",
  title: "Chess",
  elements: [{ ref: "ref_1", role: "button", name: "New game" }],
  hidden: 0,
  text: "Chess",
});
const consoleError = (text, url, line, column) => ({
  type: () => "error",
  text: () => text,
  location: () => ({ url, line, column, lineNumber: line, columnNumber: column }),
});
const thrown = (message, stack) => Object.assign(new TypeError(message), { stack });

test("a page of this machine's own reports what it threw, where, and how often", async () => {
  shot = devPage();
  await reg.run("browser_open", { url: "http://localhost:5173/" });
  const stack = `TypeError: board is null\n    at draw (http://localhost:5173/src/main.js:12:18)\n    at http://localhost:5173/src/main.js:40:3`;
  for (let i = 0; i < 3; i++) fakePage.emit("pageerror", thrown("board is null", stack));
  fakePage.emit(
    "console",
    consoleError("Failed to load resource: the server responded with a status of 404 (Not Found)", "http://localhost:5173/style.css", 0, 0)
  );
  fakePage.emit("console", { type: () => "warning", text: () => "a warning is not an error", location: () => ({ url: "" }) });
  const out = (await reg.run("browser_click", { ref: "ref_1" })).output;
  assert.match(out, /^console errors since the last snapshot \(2\):$/m);
  assert.match(out, /^ {2}Uncaught TypeError: board is null — http:\/\/localhost:5173\/src\/main\.js:12:18 \(×3\)$/m);
  assert.match(out, /^ {2}Failed to load resource: .*404 \(Not Found\) — http:\/\/localhost:5173\/style\.css$/m);
  assert.doesNotMatch(out, /a warning is not an error/);
  // Above the page text, where a long page cannot push it out of view.
  assert.ok(out.indexOf("console errors") < out.indexOf("page text:"));
  // Said once: the next snapshot reports what is new since.
  shot = devPage();
  shot.text = "Chess — your move";
  const next = (await reg.run("browser_snapshot", {})).output;
  assert.match(next, /^console errors since the last snapshot: none$/m);
});

test("an error since the last look is never answered with 'nothing has changed'", async () => {
  shot = devPage();
  await reg.run("browser_open", { url: "http://localhost:5173/" });
  // A timer that fails after the page was read: the text is the same, the
  // page is not, and looking again is exactly how that gets found.
  fakePage.emit("console", consoleError("Uncaught (in promise) Error: fetch failed", "http://localhost:5173/src/api.js", 4, 9));
  const again = (await reg.run("browser_snapshot", {})).output;
  assert.doesNotMatch(again, /^Nothing has changed/);
  assert.match(again, /^ {2}Uncaught \(in promise\) Error: fetch failed — http:\/\/localhost:5173\/src\/api\.js:5:10$/m);
});

test("what the page being left says on its way out is not blamed on the next one", async () => {
  // Measured with a real browser: the old page's game loop threw three more
  // times after the next page was asked for, and those landed in the new
  // page's report under the old page's file.
  shot = devPage();
  await reg.run("browser_open", { url: "http://localhost:5173/" });
  onGoto = () => {
    fakePage.emit("pageerror", thrown("loop is broken", "TypeError: loop is broken\n    at http://localhost:5173/old.js:3:1"));
    fakePage.emit("framenavigated", mainFrame);
    fakePage.emit("pageerror", thrown("new page broke", "TypeError: new page broke\n    at http://localhost:5174/new.js:1:1"));
  };
  shot = { ...devPage(), url: "http://localhost:5174/" };
  try {
    const out = (await reg.run("browser_open", { url: "http://localhost:5174/" })).output;
    assert.doesNotMatch(out, /loop is broken/);
    assert.match(out, /^ {2}Uncaught TypeError: new page broke — http:\/\/localhost:5174\/new\.js:1:1$/m);
  } finally {
    onGoto = null;
  }
});

test("a single-page app changing route keeps what happened before it", async () => {
  // The false-positive half: only the navigation browser_open itself starts
  // leaves a page. A click whose handler throws and then pushes a route is
  // one page, and the error is the news.
  shot = devPage();
  await reg.run("browser_open", { url: "http://localhost:5173/" });
  fakePage.emit("pageerror", thrown("move is not legal", "Error: move is not legal\n    at http://localhost:5173/src/rules.js:88:11"));
  fakePage.emit("framenavigated", mainFrame);
  const out = (await reg.run("browser_click", { ref: "ref_1" })).output;
  assert.match(out, /^ {2}Uncaught TypeError: move is not legal — http:\/\/localhost:5173\/src\/rules\.js:88:11$/m);
});

test("a site on the internet keeps its console to itself", async () => {
  // The false-positive half: a real site's trackers and blocked ads are
  // nothing the agent can fix, and reading them costs every snapshot.
  await onSignup();
  fakePage.emit("console", consoleError("Refused to load the script 'https://ads.example/x.js'", "https://example.test/signup", 0, 0));
  fakePage.emit("pageerror", thrown("ga is not defined", "TypeError: ga is not defined\n    at https://example.test/app.js:1:1"));
  const out = (await reg.run("browser_click", { ref: "ref_4" })).output;
  assert.doesNotMatch(out, /console errors/);
  assert.doesNotMatch(out, /ga is not defined|Refused to load/);
});

test("the tool says when a snapshot is worth asking for", () => {
  const snapshotTool = reg.get("browser_snapshot");
  assert.match(snapshotTool.description, /Every other browser tool already returns a fresh snapshot/);
  const typeTool = reg.get("browser_type");
  assert.ok(typeTool.parameters.properties.fields, "fields is documented");
  assert.deepEqual(typeTool.parameters.required, [], "ref and text are not required when fields is given");
});
