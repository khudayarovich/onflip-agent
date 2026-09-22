"use strict";

/**
 * A session id names a session file and nothing else.
 *
 * - The id was joined straight into a path, so `deleteSession("../config")`
 *   removed `~/.onflip/config.json` — for ChatGPT the sessions folder sits
 *   directly inside `~/.onflip`, beside it. Ids arrive from the desktop
 *   renderer and from inside session files, so they are checked where an id
 *   becomes a path.
 * - The id inside a file was trusted over its name: a copy renamed by hand
 *   loaded under the original's id, and every later save went to the
 *   original's file.
 * - `loadSession` stripped a BOM and `listSessions` did not, so a session
 *   re-saved by Notepad loaded by id and vanished from every list.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-ids-"));
delete process.env.ONFLIP_PROVIDER;
const store = require("../dist/agent/store");

const sessions = () => store.sessionsDirectory();
const fresh = () => {
  fs.rmSync(sessions(), { recursive: true, force: true });
  fs.mkdirSync(sessions(), { recursive: true });
};

test("deleting '../config' deletes nothing", () => {
  fresh();
  const config = path.join(sessions(), "..", "config.json");
  fs.writeFileSync(config, '{"model":"gpt-5-6"}');
  for (const id of ["../config", "..\\config", path.join(sessions(), "..", "config"), "..", "."]) {
    assert.equal(store.deleteSession(id), false, id);
  }
  assert.equal(fs.readFileSync(config, "utf8"), '{"model":"gpt-5-6"}');
});

test("an id that is not one loads nothing and saves nothing", () => {
  fresh();
  const outside = path.join(sessions(), "..", "elsewhere.json");
  fs.writeFileSync(outside, JSON.stringify({ id: "elsewhere", cwd: "/", messages: [] }));
  assert.equal(store.loadSession("../elsewhere"), null);
  const session = store.createSession(os.tmpdir(), "gpt-5-6");
  assert.equal(store.saveSession({ ...session, id: "../../written" }), false);
  assert.equal(fs.existsSync(path.join(sessions(), "..", "..", "written.json")), false);
});

test("real ids still save, list, load and delete", () => {
  // The false-positive half: every id OnFlip mints has to pass.
  fresh();
  const session = store.createSession(os.tmpdir(), "gpt-5-6");
  assert.ok(store.isSessionId(session.id), session.id);
  session.messages.push({ id: "m1", role: "user", content: "Fix the login bug", createdAt: Date.now() });
  assert.equal(store.saveSession(session), true);
  assert.deepEqual(store.listSessions().map((s) => s.id), [session.id]);
  assert.equal(store.loadSession(session.id)?.id, session.id);
  assert.equal(store.deleteSession(session.id), true);
  assert.deepEqual(store.listSessions(), []);
});

test("a copy renamed by hand is its own session", () => {
  fresh();
  const original = store.createSession(os.tmpdir(), "gpt-5-6");
  original.messages.push({ id: "m1", role: "user", content: "first", createdAt: Date.now() });
  store.saveSession(original);
  const copyId = `${original.id.slice(0, 15)}copy0001`;
  fs.copyFileSync(path.join(sessions(), `${original.id}.json`), path.join(sessions(), `${copyId}.json`));

  const copy = store.loadSession(copyId);
  assert.equal(copy?.id, copyId);
  assert.ok(store.listSessions().some((s) => s.id === copyId));
  copy.messages.push({ id: "m2", role: "user", content: "only in the copy", createdAt: Date.now() });
  store.saveSession(copy);
  assert.equal(store.loadSession(original.id).messages.length, 1, "the original is untouched");
});

test("a session saved with a BOM is still listed", () => {
  fresh();
  const session = store.createSession(os.tmpdir(), "gpt-5-6");
  session.messages.push({ id: "m1", role: "user", content: "hello", createdAt: Date.now() });
  store.saveSession(session);
  const file = path.join(sessions(), `${session.id}.json`);
  fs.writeFileSync(file, "﻿" + fs.readFileSync(file, "utf8"));
  assert.ok(store.loadSession(session.id));
  assert.deepEqual(store.listSessions().map((s) => s.id), [session.id]);
});
