"use strict";

/**
 * The DeepSeek sign-in believes the token the profile holds now, and only
 * one this sign-in wrote.
 *
 * Chrome's Local Storage log is append-only: a token from an earlier
 * session stays in it after the page clears it with a `null` record. Any
 * real value anywhere used to count, so that stale token closed the sign-in
 * window two seconds after it opened — before anyone had typed anything —
 * and was then believed over the page's own "signed out". The same mistake
 * had already shipped twice in other providers' sign-ins: a session
 * artefact on disk says nothing about whether a sign-in finished. The last
 * record decides the value, and only a value that differs from the one
 * before the window opened counts.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { tokenOnDisk } = require("../dist/providers/deepseek/signin");

/** A profile whose Local Storage logs hold these records, in this order. */
function profile(logs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-ds-disk-"));
  const ldb = path.join(dir, "Default", "Local Storage", "leveldb");
  fs.mkdirSync(ldb, { recursive: true });
  const record = (value) =>
    Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("_https://chat.deepseek.com\x00\x01userToken\x01"),
      Buffer.from(value === null ? '{"value":null,"__version":"0"}' : `{"value":"${value}","__version":"0"}`),
    ]);
  for (const [name, values] of Object.entries(logs)) {
    fs.writeFileSync(path.join(ldb, name), Buffer.concat(values.map(record)));
  }
  return dir;
}

test("a token cleared since is no token", () => {
  const dir = profile({ "000003.log": ["OLD-TOKEN-FROM-LAST-WEEK-abcdefghijklmnop", null] });
  try {
    assert.equal(tokenOnDisk(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the last record is the value, across logs in the order they were written", () => {
  const dir = profile({
    "000007.log": ["FIRST-TOKEN-aaaaaaaaaaaaaaaaaaaa", null],
    "000009.log": ["SECOND-TOKEN-bbbbbbbbbbbbbbbbbbbb"],
    "000010.log": [],
  });
  try {
    assert.equal(tokenOnDisk(dir), "SECOND-TOKEN-bbbbbbbbbbbbbbbbbbbb");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Numbered, not listed: log 10 is newer than log 9, whatever order the
  // directory hands them back in (alphabetical here, hashed on ext4).
  const later = profile({ "9.log": ["STALE-cccccccccccccccccccc"], "10.log": [null] });
  try {
    assert.equal(tokenOnDisk(later), null);
  } finally {
    fs.rmSync(later, { recursive: true, force: true });
  }
});

test("a profile with no logs, or no record, has no token", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-ds-disk-"));
  assert.equal(tokenOnDisk(empty), null);
  fs.rmSync(empty, { recursive: true, force: true });
  const none = profile({ "000003.log": [] });
  try {
    assert.equal(tokenOnDisk(none), null);
  } finally {
    fs.rmSync(none, { recursive: true, force: true });
  }
});

test("the sign-in only counts a token this sign-in wrote", () => {
  // The flow drives a real browser and cannot run here; its two uses of
  // the disk are checked in the source, the way approval-wiring.test.js
  // checks its call sites.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "providers", "deepseek", "signin.ts"), "utf8");
  const flow = source.slice(source.indexOf("export async function signInWithRealBrowser"));
  const before = flow.indexOf("const before = tokenOnDisk(dir);");
  assert.ok(before !== -1 && before < flow.indexOf("spawn(pick.executable"), "captured before the window opens");
  assert.match(flow, /return now !== null && now !== before;/);
  assert.match(flow, /if \(newToken\(\)\) return "token";/);
  assert.match(flow, /if \(newToken\(\)\) \{\s*logger\.warn\("deepseek", "the page check saw no session/);
  assert.equal((flow.match(/tokenOnDisk\(dir\)/g) ?? []).length, 2, "no presence check left behind");
});
