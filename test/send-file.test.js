"use strict";

/**
 * Handing a file to the person who is not at the machine.
 *
 * The bot could talk and could not deliver: asked from Telegram for a file on
 * the desktop, the best the agent could do was read it and paste the contents
 * into a chat message — which loses a PDF entirely and turns a spreadsheet
 * into a wall of commas.
 *
 * What is tested here is everything that happens before the network: whether
 * the tool exists at all, and what it refuses. Every refusal is one the model
 * has to relay to a person, so each says what is wrong rather than that
 * something is.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fileProblem, TELEGRAM_MAX_BYTES } = require("../dist/tools/deliver");
const { createToolRegistry, createSessionState } = require("../dist/tools");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-send-"));
const REAL = path.join(DIR, "report.pdf");
fs.writeFileSync(REAL, "not really a pdf, but it is bytes");
const EMPTY = path.join(DIR, "empty.txt");
fs.writeFileSync(EMPTY, "");

const registry = (deliverFile) =>
  createToolRegistry({
    cwd: DIR,
    session: createSessionState(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true, reason: "test" }),
    deliverFile,
  });

// --- the tool exists only where something can carry the file ----------------

test("with no way to deliver, the tool is not offered", () => {
  // The CLI has no bot. A tool the model can call and nothing can carry out
  // is worse than no tool: it answers a request with a silent failure.
  const names = registry(undefined).list.map((t) => t.name);
  assert.ok(!names.includes("send_file"));
});

test("with a delivery function, it is", () => {
  const names = registry(async () => ({ ok: true, detail: "sent" })).list.map((t) => t.name);
  assert.ok(names.includes("send_file"));
});

// --- what it refuses, and why -----------------------------------------------

test("a path that is not there says so, with the path", () => {
  const missing = path.join(DIR, "nope.pdf");
  assert.match(fileProblem(missing, null), /No such file/);
  assert.match(fileProblem(missing, null), /nope\.pdf/);
});

test("a folder is named as a folder, not reported as missing", () => {
  assert.match(fileProblem(DIR, fs.statSync(DIR)), /folder, not a file/);
});

test("an empty file is refused before the upload, not after", () => {
  assert.match(fileProblem(EMPTY, fs.statSync(EMPTY)), /empty \(0 bytes\)/);
});

test("over Telegram's ceiling, the message says the size and the limit", () => {
  const problem = fileProblem("big.zip", { isFile: () => true, size: 60 * 1024 * 1024 });
  assert.match(problem, /50 MB/);
  assert.match(problem, /60\.0 MB/);
  // And says what to do about it, since the model has to answer a person.
  assert.match(problem, /zip it, split it/);
});

test("a file one byte over does not report itself as exactly the limit", () => {
  // Rounded down it read "is 50.0 MB, and the limit is 50 MB", which looks
  // like a broken check rather than a file that is too big.
  const problem = fileProblem("edge.zip", { isFile: () => true, size: TELEGRAM_MAX_BYTES + 1 });
  assert.match(problem, /50\.1 MB/);
});

test("a real file has nothing wrong with it", () => {
  assert.equal(fileProblem(REAL, fs.statSync(REAL)), null);
});

// --- and the round trip through the registry --------------------------------

test("a relative path is resolved against the working directory", async () => {
  let seen = null;
  const reg = registry(async (file) => {
    seen = file;
    return { ok: true, detail: "sent report.pdf" };
  });
  const result = await reg.run("send_file", { path: "report.pdf" });

  assert.equal(seen, REAL, "the deliverer is given an absolute path");
  assert.ok(!result.error);
  assert.match(result.output, /sent report\.pdf/);
});

test("a refusal from the bot comes back as an error the model can relay", async () => {
  const reg = registry(async () => ({ ok: false, detail: "The Telegram bot is not running." }));
  const result = await reg.run("send_file", { path: REAL });

  assert.ok(result.error);
  assert.match(result.output, /not running/);
});

test("a declined permission is not an upload", async () => {
  let called = false;
  const reg = createToolRegistry({
    cwd: DIR,
    session: createSessionState(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: false, reason: "the user said no" }),
    deliverFile: async () => {
      called = true;
      return { ok: true, detail: "sent" };
    },
  });
  const result = await reg.run("send_file", { path: REAL });

  assert.equal(called, false, "nothing left the machine");
  assert.ok(result.denied);
});

test("read-only mode does not offer to send a file off the machine", () => {
  const reg = createToolRegistry({
    cwd: DIR,
    session: createSessionState(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true, reason: "test" }),
    readOnly: true,
    deliverFile: async () => ({ ok: true, detail: "sent" }),
  });
  assert.ok(!reg.list.map((t) => t.name).includes("send_file"));
});
