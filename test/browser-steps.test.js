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
  async goto() {},
};
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

const { closeAutomationBrowser } = require("../dist/tools/browser");
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

test("the tool says when a snapshot is worth asking for", () => {
  const snapshotTool = reg.get("browser_snapshot");
  assert.match(snapshotTool.description, /Every other browser tool already returns a fresh snapshot/);
  const typeTool = reg.get("browser_type");
  assert.ok(typeTool.parameters.properties.fields, "fields is documented");
  assert.deepEqual(typeTool.parameters.required, [], "ref and text are not required when fields is given");
});
