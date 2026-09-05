"use strict";

/**
 * What a session is called in the sidebar.
 *
 * The list titles a session from its first user message, and the `user` role
 * carries three different things: what the person typed, tool output on its
 * way back to the model, and OnFlip's own machinery. Only the first is a
 * name. Seen in the sidebar: a project whose session read "[Context carried
 * over from the ea…", because the turn had compacted and the handover brief
 * was the earliest user-role message left.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { isUserRequest, isSyntheticUserText } = require("../dist/agent/protocol");
const { deriveTitle, firstUserLine, isPlaceholderTitle } = require("../dist/agent/store");

const said = (role, content, extra = {}) => ({ id: role + content, role, content, ...extra });
const session = (over = {}) => ({ id: "s", title: "", cwd: "C:\\p", model: "auto", messages: [], ...over });

// --- the predicate ---------------------------------------------------------

test("what the user typed is a request", () => {
  assert.equal(isUserRequest(said("user", "can we change the mouse to a knife?")), true);
});

test("a tool result is not", () => {
  assert.equal(
    isUserRequest(said("user", '<onflip:result tool="read">…</onflip:result>', { toolName: "read" })),
    false
  );
  // Recognised by its text even when the marker field is missing, which is
  // how older sessions were written.
  assert.equal(isUserRequest(said("user", '<onflip:result tool="read">…</onflip:result>')), false);
});

test("OnFlip's own notes are not", () => {
  for (const text of [
    "[OnFlip protocol error — automated message; do not answer it conversationally]",
    "[OnFlip protocol reminder]",
    "[Context carried over from the earlier part of this session]",
  ]) {
    assert.equal(isUserRequest(said("user", text)), false, text);
    assert.equal(isSyntheticUserText(text), true, text);
  }
});

test("an assistant message is never a request", () => {
  assert.equal(isUserRequest(said("assistant", "on it")), false);
});

// --- the title ------------------------------------------------------------

test("the title is what the user asked, not the handover after it", () => {
  const s = session({
    messages: [
      said("system", "prompt"),
      said("user", "build me a fruit slicing game"),
      said("assistant", "done"),
      said("user", "[Context carried over from the earlier part of this session]\n\nnotes"),
    ],
  });

  assert.equal(deriveTitle(s), "build me a fruit slicing game");
});

test("a compacted session is named from what it archived", () => {
  // Compaction moves the transcript to `archived` and leaves the live
  // history starting at the handover brief, so the opening request is in
  // `archived` and nowhere else. Looking only at what is live called a
  // 48-message session "(empty session)".
  const s = session({
    archived: [said("user", "make me an animated three.js page"), said("assistant", "…")],
    messages: [said("user", "[Context carried over from the earlier part of this session]")],
  });

  assert.equal(deriveTitle(s), "make me an animated three.js page");
});

test("a session with nothing but machinery anywhere has no name", () => {
  // Empty rather than a placeholder: "(empty session)" was being shown as
  // though it were a title, across the top of every new chat. Each surface
  // has its own wording for nothing.
  const s = session({
    messages: [said("user", "[Context carried over from the earlier part of this session]")],
  });

  assert.equal(deriveTitle(s), "");
});

test("a real title from ChatGPT wins", () => {
  const s = session({ title: "Fruit Slash cursor", messages: [said("user", "hi")] });
  assert.equal(deriveTitle(s), "Fruit Slash cursor");
});

test("a bad title already saved heals itself", () => {
  // These were written to disk before this was fixed. Trusting the stored
  // value would leave those sessions wearing the wrong name forever.
  const s = session({
    title: "[Context carried over from the earlier part of this session]",
    messages: [said("user", "make the cursor a knife")],
  });

  assert.equal(deriveTitle(s), "make the cursor a knife");
});

test("a marker ChatGPT named the thread after is not a title", () => {
  // Seen in the sidebar. OnFlip asks the model to answer exactly
  // "[attachment unreadable]" when it cannot open an attached turn; ChatGPT
  // then named the whole conversation after the only thing in it.
  assert.equal(isPlaceholderTitle("[attachment unreadable]"), true);

  const s = session({
    title: "[attachment unreadable]",
    messages: [said("user", "add a knife cursor to the game")],
  });
  assert.equal(deriveTitle(s), "add a knife cursor to the game");
});

test("someone's own words that merely open with a bracket are kept", () => {
  assert.equal(isPlaceholderTitle("[BUG] the login form eats the password"), false);
  const s = session({ title: "[BUG] the login form eats the password" });
  assert.equal(deriveTitle(s), "[BUG] the login form eats the password");
});

test("a blank title falls through to the request", () => {
  assert.equal(isPlaceholderTitle("   "), true);
});

test("only the first line is used, and it is capped", () => {
  const s = session({ messages: [said("user", `${"x".repeat(200)}\nsecond line`)] });
  const title = firstUserLine(s.messages);

  assert.equal(title.length, 80);
  assert.ok(!title.includes("second line"));
});
