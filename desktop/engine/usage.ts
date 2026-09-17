import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { configDir } from "onflip/dist/config";
import { logger } from "onflip/dist/log";
import { bundledSqliteBinding } from "onflip/dist/auth/session";

/** Local per-account request counting, shared safely by every engine window. */

interface LegacyAccountUsage {
  total: number;
  since: number;
  days: Record<string, number>;
}

type LegacyUsageFile = Record<string, LegacyAccountUsage>;

export interface UsageSummary {
  today: number;
  week: number;
  month: number;
  total: number;
  since: number;
}

const KEEP_DAYS = 62;
export const UNKNOWN_ACCOUNT = "default";

let database: Database.Database | undefined;
let retryOpenAfter = 0;

function legacyUsageFile(): string {
  return path.join(configDir(), "usage.json");
}

function databaseFile(): string {
  return path.join(configDir(), "usage.sqlite3");
}

function createDatabase(file: string): Database.Database {
  try {
    return new Database(file, { timeout: 10_000 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)) throw e;
    const nativeBinding = bundledSqliteBinding();
    if (!nativeBinding) throw e;
    return new Database(file, { timeout: 10_000, nativeBinding });
  }
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function migrateLegacy(db: Database.Database): void {
  db.transaction(() => {
    const done = db.prepare("SELECT value FROM usage_meta WHERE key = 'legacy-json-migrated'").get();
    if (done) return;

    let legacy: LegacyUsageFile = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyUsageFile(), "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        legacy = parsed as LegacyUsageFile;
      }
    } catch {
      // Missing or malformed legacy data must not prevent the durable store.
    }

    const accountStatement = db.prepare(`
      INSERT INTO usage_accounts (account, total, since)
      VALUES (?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET
        total = usage_accounts.total + excluded.total,
        since = MIN(usage_accounts.since, excluded.since)
    `);
    const dayStatement = db.prepare(`
      INSERT INTO usage_days (account, day, count)
      VALUES (?, ?, ?)
      ON CONFLICT(account, day) DO UPDATE SET count = usage_days.count + excluded.count
    `);
    for (const [account, value] of Object.entries(legacy)) {
      if (!value || typeof value !== "object") continue;
      const total = Math.max(0, Math.floor(Number(value.total) || 0));
      const since = Math.max(0, Math.floor(Number(value.since) || Date.now()));
      accountStatement.run(account, total, since);
      for (const [day, rawCount] of Object.entries(value.days ?? {})) {
        const count = Math.max(0, Math.floor(Number(rawCount) || 0));
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && count) dayStatement.run(account, day, count);
      }
    }
    db.prepare("INSERT INTO usage_meta (key, value) VALUES ('legacy-json-migrated', ?)").run(
      String(Date.now())
    );
  }).immediate();
}

function openDatabase(): Database.Database | null {
  if (database) return database;
  if (Date.now() < retryOpenAfter) return null;
  let opened: Database.Database | undefined;
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    const db = createDatabase(databaseFile());
    opened = db;
    // Install contention handling before any pragma or schema write: twenty
    // windows can all be the first opener after an upgrade.
    db.pragma("busy_timeout = 10000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_accounts (
        account TEXT PRIMARY KEY,
        total INTEGER NOT NULL,
        since INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_days (
        account TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (account, day)
      );
    `);
    migrateLegacy(db);
    try {
      db.pragma("journal_mode = WAL");
    } catch {
      // Another first opener may still be changing the journal. Rollback
      // mode is fully process-safe too; a later opener can enable WAL.
    }
    try {
      fs.chmodSync(databaseFile(), 0o600);
    } catch {
      // The containing directory is private too; chmod is extra hardening.
    }
    database = db;
  } catch (e) {
    // A schema or migration failure happens after the native handle opens.
    // Close that partial handle and retry later: a temporary lock or disk
    // error must not disable counting for the rest of the engine process.
    try {
      opened?.close();
    } catch {
      // The original open error is the useful one to log.
    }
    retryOpenAfter = Date.now() + 5_000;
    logger.warn("usage", "usage database could not be opened", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return database ?? null;
}

export function recordSend(accountKey: string): void {
  const db = openDatabase();
  if (!db) return;
  const account = accountKey || UNKNOWN_ACCOUNT;
  const now = Date.now();
  const today = dayKey(new Date(now));
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO usage_accounts (account, total, since) VALUES (?, 1, ?)
        ON CONFLICT(account) DO UPDATE SET total = usage_accounts.total + 1
      `).run(account, now);
      db.prepare(`
        INSERT INTO usage_days (account, day, count) VALUES (?, ?, 1)
        ON CONFLICT(account, day) DO UPDATE SET count = usage_days.count + 1
      `).run(account, today);
      db.prepare(`
        DELETE FROM usage_days
        WHERE account = ? AND day NOT IN (
          SELECT day FROM usage_days WHERE account = ? ORDER BY day DESC LIMIT ?
        )
      `).run(account, account, KEEP_DAYS);
    })();
  } catch (e) {
    logger.warn("usage", "request count could not be recorded", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Fold requests made before account discovery into the identified account. */
export function associateAccount(accountKey: string): void {
  if (!accountKey || accountKey === UNKNOWN_ACCOUNT) return;
  const db = openDatabase();
  if (!db) return;
  try {
    db.transaction(() => {
      const anonymous = db
        .prepare("SELECT total, since FROM usage_accounts WHERE account = ?")
        .get(UNKNOWN_ACCOUNT) as { total: number; since: number } | undefined;
      if (!anonymous) return;
      db.prepare(`
        INSERT INTO usage_accounts (account, total, since) VALUES (?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET
          total = usage_accounts.total + excluded.total,
          since = MIN(usage_accounts.since, excluded.since)
      `).run(accountKey, anonymous.total, anonymous.since);
      const days = db
        .prepare("SELECT day, count FROM usage_days WHERE account = ?")
        .all(UNKNOWN_ACCOUNT) as { day: string; count: number }[];
      const mergeDay = db.prepare(`
        INSERT INTO usage_days (account, day, count) VALUES (?, ?, ?)
        ON CONFLICT(account, day) DO UPDATE SET count = usage_days.count + excluded.count
      `);
      for (const day of days) mergeDay.run(accountKey, day.day, day.count);
      db.prepare("DELETE FROM usage_days WHERE account = ?").run(UNKNOWN_ACCOUNT);
      db.prepare("DELETE FROM usage_accounts WHERE account = ?").run(UNKNOWN_ACCOUNT);
    })();
  } catch (e) {
    logger.warn("usage", "anonymous request counts could not be associated", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export function usageSummary(accountKey: string): UsageSummary {
  const db = openDatabase();
  if (!db) return { today: 0, week: 0, month: 0, total: 0, since: 0 };
  const account = accountKey || UNKNOWN_ACCOUNT;
  try {
    const totals = db
      .prepare("SELECT total, since FROM usage_accounts WHERE account = ?")
      .get(account) as { total: number; since: number } | undefined;
    if (!totals) return { today: 0, week: 0, month: 0, total: 0, since: 0 };
    const rows = db
      .prepare("SELECT day, count FROM usage_days WHERE account = ?")
      .all(account) as { day: string; count: number }[];
    const counts = new Map(rows.map((row) => [row.day, row.count]));
    const now = new Date();
    let today = 0;
    let week = 0;
    let month = 0;
    for (let back = 0; back < 30; back++) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      const count = counts.get(dayKey(date)) ?? 0;
      if (back === 0) today += count;
      if (back < 7) week += count;
      month += count;
    }
    return { today, week, month, total: totals.total, since: totals.since };
  } catch {
    return { today: 0, week: 0, month: 0, total: 0, since: 0 };
  }
}

export function closeUsageStore(): void {
  database?.close();
  database = undefined;
  retryOpenAfter = 0;
}
