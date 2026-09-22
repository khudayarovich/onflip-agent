"use strict";

/**
 * The Telegram bridge across a restart, driven against a fake Bot API.
 *
 * Three faults, each reproduced with this harness before it was fixed:
 *
 *  - Button tickets were counters from zero, reset on every launch and every
 *    settings save, so a button left in the chat from before landed on
 *    whatever the new run gave the same number. An old "Access" button
 *    approved a pending shell command, and the phone said "always allowed".
 *  - Taking someone off the allow-list stopped them sending commands but not
 *    receiving: every answer, prompt and delivered file still went to them.
 *  - A restart stopped the old polling loop with flags a quarter second
 *    before setting them again, while the old loop slept in a long poll — so
 *    it woke up and kept going. Two loops fought with 409s for as long as
 *    the app ran, and a message fetched by the old loop was acted on after
 *    the bot had been disabled.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "telegram.js");
const SHARED = path.join(__dirname, "..", "dist", "shared", "telegram-commands.js");
const needsBuild = fs.existsSync(DIST) && fs.existsSync(SHARED)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh copy of the bridge, with `electron` stubbed and its files in `userData`. */
function loadTelegram(userData) {
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-telegram-lifecycle";
    return original.call(this, request, ...rest);
  };
  require.cache["electron-stub-telegram-lifecycle"] = {
    id: "electron-stub-telegram-lifecycle",
    filename: "electron-stub-telegram-lifecycle",
    loaded: true,
    exports: {
      app: { getPath: () => userData },
      safeStorage: { isEncryptionAvailable: () => false },
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = original;
  }
}

/** Telegram's Bot API, as far as the bridge uses it, with its 409 for two long polls. */
function fakeTelegram({ holdMs = 600 } = {}) {
  const t = { queue: [], inflight: null, nextId: 1000, msgId: 0, sent: [], answered: [], conflicts: 0, polls: 0 };
  const resp = (json) => ({ json: async () => json });
  t.push = (update) => {
    update.update_id = t.nextId++;
    t.queue.push(update);
    if (t.inflight) {
      const me = t.inflight;
      t.inflight = null;
      clearTimeout(me.timer);
      me.resolve(resp({ ok: true, result: t.queue.splice(0) }));
    }
  };
  global.fetch = async (url, opts = {}) => {
    const method = String(url).split("/").pop();
    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : {};
    if (method === "getUpdates") {
      t.polls++;
      if (t.inflight) {
        const old = t.inflight;
        t.inflight = null;
        clearTimeout(old.timer);
        t.conflicts++;
        old.resolve(resp({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }));
      }
      if (t.queue.length) return resp({ ok: true, result: t.queue.splice(0) });
      return new Promise((resolve, reject) => {
        const me = { resolve };
        me.timer = setTimeout(() => {
          if (t.inflight === me) t.inflight = null;
          resolve(resp({ ok: true, result: t.queue.splice(0) }));
        }, holdMs);
        t.inflight = me;
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(me.timer);
          if (t.inflight === me) t.inflight = null;
          reject(new Error("aborted"));
        });
      });
    }
    if (method === "getMe") return resp({ ok: true, result: { username: "test_bot" } });
    if (method === "sendMessage") {
      t.sent.push(body);
      return resp({ ok: true, result: { message_id: ++t.msgId } });
    }
    if (method === "answerCallbackQuery") t.answered.push(body);
    return resp({ ok: true, result: true });
  };
  return t;
}

function userData(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-tg-"));
  fs.writeFileSync(path.join(dir, "telegram.json"), JSON.stringify(settings));
  return dir;
}

function host(overrides = {}) {
  const prompts = [];
  const answers = [];
  return {
    prompts,
    answers,
    status: () => ({ provider: "chatgpt", approvalModes: ["read-only", "ask", "auto-edit"] }),
    call: async (method, params) => {
      if (method === "send") prompts.push(params);
      if (method === "listModels" || method === "recentProjects") return [];
      return {};
    },
    changed() {},
    answerApproval: (id, decision) => {
      answers.push({ id, decision });
      return true;
    },
    providers: () => ({ id: "chatgpt", label: "ChatGPT", all: [{ id: "chatgpt", label: "ChatGPT" }] }),
    switchProvider: async () => ({ ok: true }),
    ...overrides,
  };
}

test("a ticket from an earlier run matches nothing in this one", { skip: needsBuild }, () => {
  const { CallbackTable, deliverableChats } = require(SHARED);
  const table = new CallbackTable();
  const old = table.put("settings", "access");
  table.clear();
  const fresh = table.put("approve", "1");
  assert.notEqual(old, fresh);
  assert.equal(table.take(old), null);
  assert.deepEqual(table.take(fresh), { action: "approve", value: "1" });
  table.forget(["approve"], "1");
  assert.equal(table.take(fresh), null, "a settled approval's buttons answer nothing");
  assert.deepEqual(deliverableChats([42], [42, 77]), [42], "a remembered chat off the list gets nothing");
});

test("a button from before a restart is answered as expired, never obeyed", { skip: needsBuild }, async () => {
  const fake = fakeTelegram();
  const tg = loadTelegram(userData({ enabled: true, token: "1:fake", allowedIds: "42", chats: [42] }));
  const bot = host();
  tg.startTelegram(bot);
  await sleep(500);
  fake.push({ message: { chat: { id: 42 }, from: { id: 42 }, text: "/settings" } });
  await sleep(300);
  const oldButtons = fake.sent.at(-1).reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

  tg.saveTelegram({ allowedIds: "42" });
  await sleep(700);
  tg.telegramAskApproval(1, { kind: "command", tool: "bash", subject: "Remove-Item -Recurse C:\\work", rememberLabel: "Always allow" });
  await sleep(300);

  for (const [i, data] of oldButtons.entries()) {
    fake.push({ callback_query: { id: `cb-${i}`, from: { id: 42 }, message: { chat: { id: 42 } }, data } });
  }
  await sleep(400);
  tg.stopTelegram();
  assert.deepEqual(bot.answers, [], "no old button answered the new prompt");
  assert.ok(fake.answered.every((a) => /expired/.test(a.text ?? "")), JSON.stringify(fake.answered));
});

test("someone taken off the list stops receiving, and is not saved back", { skip: needsBuild }, async () => {
  const fake = fakeTelegram();
  const dir = userData({ enabled: true, token: "1:fake", allowedIds: "42 77", chats: [42, 77] });
  const tg = loadTelegram(dir);
  tg.startTelegram(host());
  await sleep(500);
  tg.saveTelegram({ allowedIds: "42" });
  await sleep(600);
  fake.sent.length = 0;
  tg.telegramAskApproval(5, { kind: "command", tool: "bash", subject: "ls" });
  await sleep(300);
  tg.stopTelegram();
  assert.deepEqual([...new Set(fake.sent.map((m) => m.chat_id))], [42]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "telegram.json"), "utf8")).chats, [42]);
});

test("a restart leaves one loop polling, and a disabled bot acts on nothing", { skip: needsBuild }, async () => {
  // A stale loop backs off after its poll is refused; short here, so one
  // that failed to stop polls again inside the window and shows up.
  process.env.ONFLIP_TELEGRAM_BACKOFF_MS = "100";
  const fake = fakeTelegram({ holdMs: 1_500 });
  const tg = loadTelegram(userData({ enabled: true, token: "1:fake", allowedIds: "42", chats: [42] }));
  const bot = host();
  tg.startTelegram(bot);
  await sleep(600);
  tg.saveTelegram({ allowedIds: "42" });
  await sleep(4_000);
  const conflictsAfterSettling = fake.conflicts;
  await sleep(3_000);
  assert.equal(fake.conflicts, conflictsAfterSettling, "no loop still fighting another for the poll");

  tg.saveTelegram({ enabled: false });
  fake.push({ message: { chat: { id: 42 }, from: { id: 42 }, text: "delete the build folder" } });
  await sleep(800);
  tg.stopTelegram();
  assert.deepEqual(bot.prompts, [], "nothing reached the engine after the bot was disabled");
});
