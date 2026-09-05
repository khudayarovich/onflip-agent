"use strict";

/**
 * Who gets in, and what they asked for.
 *
 * A bot token is an address anyone can message, and what is on the other end
 * of this one runs shell commands on somebody's computer. The allow-list is
 * the whole of the security model, so its edges are worth more tests than
 * the rest of the feature put together.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "telegram-commands.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const load = () => require(DIST);

// --- who is allowed --------------------------------------------------------

test("an empty allow-list admits nobody", { skip: needsBuild }, () => {
  // The obvious alternative — empty means everyone — turns a half-finished
  // setup into a bot that lets any stranger run commands on the machine,
  // exactly while somebody has pasted a token and not yet added their id.
  const { isAllowed } = load();

  assert.equal(isAllowed(12345, []), false);
  assert.equal(isAllowed(undefined, []), false);
});

test("only the listed ids get in", { skip: needsBuild }, () => {
  const { isAllowed, parseAllowList } = load();
  const list = parseAllowList("111, 222");

  assert.equal(isAllowed(111, list), true);
  assert.equal(isAllowed(222, list), true);
  assert.equal(isAllowed(333, list), false);
});

test("a missing sender is never allowed", { skip: needsBuild }, () => {
  // Telegram omits `from` on channel posts; an id-less update must not pass.
  const { isAllowed, parseAllowList } = load();

  assert.equal(isAllowed(undefined, parseAllowList("111")), false);
});

test("ids are read however they were typed", { skip: needsBuild }, () => {
  const { parseAllowList } = load();

  assert.deepEqual(parseAllowList("111,222"), [111, 222]);
  assert.deepEqual(parseAllowList("111 222"), [111, 222]);
  assert.deepEqual(parseAllowList("111\n222;333"), [111, 222, 333]);
  assert.deepEqual(parseAllowList("  111  "), [111]);
  assert.deepEqual(parseAllowList("111, 111"), [111]);
});

test("anything that is not a plain id is dropped, not guessed at", { skip: needsBuild }, () => {
  // An id that half parses is an id that lets the wrong person in.
  const { parseAllowList } = load();

  assert.deepEqual(parseAllowList("@someone"), []);
  assert.deepEqual(parseAllowList("-100123"), []);
  assert.deepEqual(parseAllowList("12.5"), []);
  assert.deepEqual(parseAllowList("111abc"), []);
  assert.deepEqual(parseAllowList(""), []);
  assert.deepEqual(parseAllowList("111, oops, 222"), [111, 222]);
});

// --- what they said --------------------------------------------------------

test("an ordinary message is a prompt", { skip: needsBuild }, () => {
  const { parseIncoming } = load();

  assert.deepEqual(parseIncoming("fix the login bug"), {
    kind: "prompt",
    text: "fix the login bug",
  });
});

test("the commands are recognised, with their argument", { skip: needsBuild }, () => {
  const { parseIncoming } = load();

  assert.deepEqual(parseIncoming("/status"), { kind: "command", name: "status", argument: "" });
  assert.deepEqual(parseIncoming("/folder C:\\work\\shop"), {
    kind: "command",
    name: "folder",
    argument: "C:\\work\\shop",
  });
});

test("a command addressed to the bot in a group still counts", { skip: needsBuild }, () => {
  const { parseIncoming } = load();

  assert.deepEqual(parseIncoming("/status@my_onflip_bot"), {
    kind: "command",
    name: "status",
    argument: "",
  });
});

test("an unknown slash word is a prompt, not an error", { skip: needsBuild }, () => {
  // "/usr/bin is missing" is something to work on, not a typo to scold.
  const { parseIncoming } = load();

  assert.equal(parseIncoming("/usr/bin is missing").kind, "prompt");
  assert.equal(parseIncoming("/deploy now").kind, "prompt");
});

test("an empty message is nothing at all", { skip: needsBuild }, () => {
  const { parseIncoming } = load();

  assert.equal(parseIncoming("   ").kind, "empty");
  assert.equal(parseIncoming("").kind, "empty");
});

// --- the buttons -----------------------------------------------------------

test("a button's data always fits Telegram's 64 bytes", { skip: needsBuild }, () => {
  // Seen live: the folder picker came back BUTTON_DATA_INVALID and the whole
  // message was never delivered, because a Windows project path is longer
  // than the entire budget on its own.
  const { CallbackTable, CALLBACK_LIMIT } = load();
  const tickets = new CallbackTable();
  // String.raw so the backslashes are backslashes: written any other way
  // this stops being the Windows path the bug was about.
  const monster = String.raw`C:\Users\somebody\AppData\Local\Temp\a-very-long-project-folder-name-indeed\nested\deeper`;

  const data = tickets.put("folder", monster);
  assert.ok(
    Buffer.byteLength(data, "utf8") <= CALLBACK_LIMIT,
    `${Buffer.byteLength(data, "utf8")} bytes`
  );
  assert.deepEqual(tickets.take(data), { action: "folder", value: monster });
});

test("hundreds of buttons all stay within the limit", { skip: needsBuild }, () => {
  const { CallbackTable, CALLBACK_LIMIT } = load();
  const tickets = new CallbackTable();

  for (let i = 0; i < 2000; i++) {
    const data = tickets.put("model", "some-model-slug-" + i);
    assert.ok(Buffer.byteLength(data, "utf8") <= CALLBACK_LIMIT);
  }
});

test("a value keeps every character, colons and backslashes included", { skip: needsBuild }, () => {
  const { CallbackTable } = load();
  const tickets = new CallbackTable();
  const value = String.raw`C:\work\shop:v2`;

  assert.equal(tickets.take(tickets.put("folder", value)).value, value);
});

test("data that is not ours is refused", { skip: needsBuild }, () => {
  const { CallbackTable } = load();
  const tickets = new CallbackTable();

  assert.equal(tickets.take("something:else"), null);
  assert.equal(tickets.take(""), null);
  assert.equal(tickets.take(undefined), null);
  // A ticket that was never issued — a button from before a restart.
  assert.equal(tickets.take("onflip:zzz"), null);
});

test("the table does not grow without bound", { skip: needsBuild }, () => {
  // A stale ticket is answered, not obeyed; an unbounded map is a leak for
  // the life of the process.
  const { CallbackTable } = load();
  const tickets = new CallbackTable();
  const first = tickets.put("model", "the-first-one");

  for (let i = 0; i < 1000; i++) tickets.put("model", "m" + i);

  assert.equal(tickets.take(first), null, "the oldest ticket should have been evicted");
});

test("clearing forgets everything", { skip: needsBuild }, () => {
  const { CallbackTable } = load();
  const tickets = new CallbackTable();
  const data = tickets.put("model", "x");
  tickets.clear();

  assert.equal(tickets.take(data), null);
});
