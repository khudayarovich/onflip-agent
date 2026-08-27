import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "onflip/dist/config";

/**
 * Local, per-account request counting.
 *
 * ChatGPT's web session exposes no usage endpoint OnFlip can rely on, so the
 * desktop app counts what it can see: every message request the transport
 * sends. One `send` is one request to the model — a multi-step turn counts
 * once per step, which is what actually draws on the account's limits.
 *
 * Counts live in ~/.onflip/usage.json keyed by account email. Requests made
 * before the account is known land under "default" and are merged into the
 * account the first time it is identified, so early usage is not orphaned.
 */

interface AccountUsage {
  total: number;
  /** Epoch millis of the first counted request. */
  since: number;
  /** Per-day counts keyed YYYY-MM-DD (local time). */
  days: Record<string, number>;
}

type UsageFile = Record<string, AccountUsage>;

export interface UsageSummary {
  today: number;
  week: number;
  month: number;
  total: number;
  since: number;
}

const KEEP_DAYS = 62;
export const UNKNOWN_ACCOUNT = "default";

function usageFile(): string {
  return path.join(configDir(), "usage.json");
}

function load(): UsageFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageFile(), "utf8")) as UsageFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(data: UsageFile): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(usageFile(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Counting is a convenience; never let it interfere with a session.
  }
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function prune(account: AccountUsage): void {
  const keys = Object.keys(account.days).sort();
  while (keys.length > KEEP_DAYS) {
    delete account.days[keys.shift() as string];
  }
}

export function recordSend(accountKey: string): void {
  const data = load();
  const key = accountKey || UNKNOWN_ACCOUNT;
  const account = (data[key] ??= { total: 0, since: Date.now(), days: {} });
  account.total += 1;
  const today = dayKey(new Date());
  account.days[today] = (account.days[today] ?? 0) + 1;
  prune(account);
  save(data);
}

/**
 * Fold the anonymous bucket into a newly identified account, so requests made
 * before the first successful sign-in read are not lost to the display.
 */
export function associateAccount(accountKey: string): void {
  if (!accountKey || accountKey === UNKNOWN_ACCOUNT) return;
  const data = load();
  const anonymous = data[UNKNOWN_ACCOUNT];
  if (!anonymous) return;
  const account = (data[accountKey] ??= { total: 0, since: anonymous.since, days: {} });
  account.total += anonymous.total;
  account.since = Math.min(account.since, anonymous.since);
  for (const [day, count] of Object.entries(anonymous.days)) {
    account.days[day] = (account.days[day] ?? 0) + count;
  }
  prune(account);
  delete data[UNKNOWN_ACCOUNT];
  save(data);
}

export function usageSummary(accountKey: string): UsageSummary {
  const data = load();
  const account = data[accountKey || UNKNOWN_ACCOUNT];
  if (!account) return { today: 0, week: 0, month: 0, total: 0, since: 0 };

  const now = new Date();
  let today = 0;
  let week = 0;
  let month = 0;
  for (let back = 0; back < 30; back++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const count = account.days[dayKey(date)] ?? 0;
    if (back === 0) today += count;
    if (back < 7) week += count;
    month += count;
  }
  return { today, week, month, total: account.total, since: account.since };
}
