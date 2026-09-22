"use strict";

/**
 * The doctor's "profile is signed in" is asked of the cookie database.
 *
 * It searched the file's bytes for the session cookie's name, and SQLite
 * keeps the bytes of rows it deletes: after a sign-out the name was still
 * in the file, and the doctor — the thing meant to be trusted — reported a
 * signed-in profile. It also could not see a session written moments ago
 * that was still in the `-wal` file. The byte scan survives only as the
 * fallback for a database that cannot be opened.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-doctor-session-"));
delete process.env.ONFLIP_PROVIDER;
const { profileHasSession, liveSessionCookies } = require("../dist/chatgpt/doctor");

// The engine CI job installs with --ignore-scripts, so there may be no
// sqlite binding to build a fixture with.
let Database = null;
try {
  Database = require("better-sqlite3");
  new Database(":memory:").close();
} catch {
  Database = null;
}
const needsSqlite = Database ? false : "no sqlite binding in this install";

const NAME = "__Secure-next-auth.session-token";
const cookiesFile = path.join(process.env.ONFLIP_CONFIG_DIR, "browser-profile", "Default", "Network", "Cookies");
const chromeTime = (ms) => (BigInt(ms) + 11_644_473_600_000n) * 1000n;

function freshStore() {
  fs.rmSync(path.dirname(path.dirname(cookiesFile)), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cookiesFile), { recursive: true });
  const db = new Database(cookiesFile);
  db.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)"
  );
  return db;
}

const insert = (db, name, expires) =>
  db
    .prepare("INSERT INTO cookies VALUES ('chatgpt.com', ?, '', ?, ?)")
    .run(name, Buffer.from("v10-encrypted-bytes"), expires);

test("a live session cookie is a signed-in profile", { skip: needsSqlite }, () => {
  const db = freshStore();
  insert(db, NAME, chromeTime(Date.now() + 86_400_000));
  db.close();
  assert.equal(liveSessionCookies(cookiesFile), 1);
  assert.equal(profileHasSession(), true);
});

test("one deleted at sign-out is not, though its bytes are still in the file", { skip: needsSqlite }, () => {
  const db = freshStore();
  insert(db, `${NAME}.0`, chromeTime(Date.now() + 86_400_000));
  db.prepare("DELETE FROM cookies").run();
  db.close();
  assert.ok(fs.readFileSync(cookiesFile).includes(NAME), "the name survives in the file — the case this is about");
  assert.equal(profileHasSession(), false);
});

test("and neither is one that has expired", { skip: needsSqlite }, () => {
  const db = freshStore();
  insert(db, NAME, chromeTime(Date.now() - 60_000));
  db.close();
  assert.equal(profileHasSession(), false);
});

test("a file that is not a database falls back to its bytes", () => {
  fs.rmSync(path.dirname(path.dirname(cookiesFile)), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cookiesFile), { recursive: true });
  fs.writeFileSync(cookiesFile, `not sqlite, but it names ${NAME}`);
  assert.equal(liveSessionCookies(cookiesFile), null);
  assert.equal(profileHasSession(), true);
});

test("a store that cannot be read at all is unknown, not signed out", () => {
  // What a running browser's lock looks like from here: the file is there
  // and neither a copy nor a read of it can be made. (A folder in its place
  // fails both the same way, without needing a browser.)
  fs.rmSync(path.dirname(path.dirname(cookiesFile)), { recursive: true, force: true });
  fs.mkdirSync(cookiesFile, { recursive: true });
  assert.equal(profileHasSession(), null);
});
