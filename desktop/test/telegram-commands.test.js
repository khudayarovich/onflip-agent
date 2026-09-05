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

test("callback data survives a round trip", { skip: needsBuild }, () => {
  const { encodeCallback, decodeCallback } = load();

  assert.deepEqual(decodeCallback(encodeCallback("model", "gpt-5-6-mini")), {
    action: "model",
    value: "gpt-5-6-mini",
  });
});

test("a value containing colons is not cut in half", { skip: needsBuild }, () => {
  // Windows paths go through here: "folder" plus "C:\work" is two colons.
  const { encodeCallback, decodeCallback } = load();
  const round = decodeCallback(encodeCallback("folder", "C:\\work\\shop"));

  assert.equal(round.action, "folder");
  assert.equal(round.value, "C:\\work\\shop");
});

test("data from anything but this bot is refused", { skip: needsBuild }, () => {
  const { decodeCallback } = load();

  assert.equal(decodeCallback("something:else"), null);
  assert.equal(decodeCallback(""), null);
  assert.equal(decodeCallback(undefined), null);
});
