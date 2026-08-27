import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatMessage, TodoItem, FileSnapshot } from "../types";
import { configDir } from "../config";

/**
 * On-disk session store. Sessions are plain JSON so they can be inspected,
 * diffed and deleted by hand, and are keyed by working directory so
 * `--continue` picks up the right one.
 */

export interface StoredSession {
  /**
   * The ChatGPT conversation this session is attached to, when it continues
   * one started on chatgpt.com rather than a thread OnFlip opened itself.
   */
  chatId?: string;
  /**
   * Every conversation OnFlip itself opened on chatgpt.com for this session
   * (compaction and resets each open a fresh one). Recorded so deleting the
   * session can delete them too. `chatId` is deliberately not included:
   * a thread the user attached is theirs, not OnFlip's to remove.
   */
  chatIds?: string[];
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /**
   * Messages compaction removed from the model's context, kept only so the
   * transcript still reads as a conversation. They are never sent — summarising
   * exists precisely to stop sending them — but losing them from the screen
   * meant a compaction looked like the chat had been deleted.
   */
  archived?: ChatMessage[];
  todos: TodoItem[];
  /** Kept for /undo; trimmed to the most recent changes. */
  snapshots: FileSnapshot[];
}

const MAX_SNAPSHOTS = 200;

function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

export function newSessionId(): string {
  // Sorts chronologically in a directory listing, which makes the raw files
  // browsable without the CLI.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function createSession(cwd: string, model: string): StoredSession {
  const now = Date.now();
  return {
    id: newSessionId(),
    title: "",
    cwd: path.resolve(cwd),
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    todos: [],
    snapshots: [],
  };
}

/**
 * Snapshots hold whole file contents before and after each write. They stay in
 * memory at full size so /undo works, but persisting a few hundred copies of a
 * large file would turn a session file into megabytes, so oversized ones are
 * recorded without their bodies.
 */
const MAX_PERSISTED_SNAPSHOT_BYTES = 256 * 1024;

function trimForDisk(snapshots: FileSnapshot[]): FileSnapshot[] {
  return snapshots.slice(-MAX_SNAPSHOTS).map((s) => {
    const size = Buffer.byteLength(s.before ?? "", "utf8") + Buffer.byteLength(s.after ?? "", "utf8");
    if (size <= MAX_PERSISTED_SNAPSHOT_BYTES) return s;
    return { ...s, before: null, after: null, contentsOmitted: true };
  });
}

/** Whether a persisted snapshot still has enough information to undo safely. */
export function snapshotContentsAvailable(snapshot: FileSnapshot): boolean {
  // Older session files predate `contentsOmitted`; both nulls were the legacy
  // representation for an oversized snapshot and must never mean "delete".
  return snapshot.contentsOmitted !== true && !(snapshot.before === null && snapshot.after === null);
}

export function saveSession(session: StoredSession): void {
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const trimmed: StoredSession = {
      ...session,
      updatedAt: Date.now(),
      snapshots: trimForDisk(session.snapshots),
    };
    fs.writeFileSync(sessionFile(session.id), JSON.stringify(trimmed, null, 2), {
      mode: 0o600,
    });
  } catch {
    // Persistence is a convenience; never let it take down a live session.
  }
}

export function loadSession(id: string): StoredSession | null {
  try {
    const raw = fs.readFileSync(sessionFile(id), "utf8");
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.id || !Array.isArray(parsed.messages)) return null;
    parsed.todos ??= [];
    parsed.snapshots ??= [];
    parsed.snapshots = parsed.snapshots.map((snapshot) =>
      snapshot.before === null && snapshot.after === null
        ? { ...snapshot, contentsOmitted: true }
        : snapshot
    );
    return parsed;
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  try {
    fs.rmSync(sessionFile(id), { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  model: string;
  updatedAt: number;
  messageCount: number;
}

export function listSessions(opts?: { cwd?: string; limit?: number }): SessionSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const out: SessionSummary[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir(), f), "utf8");
      const s = JSON.parse(raw) as StoredSession;
      if (!s?.id) continue;
      if (opts?.cwd && path.resolve(s.cwd) !== path.resolve(opts.cwd)) continue;
      out.push({
        id: s.id,
        title: s.title || firstUserLine(s.messages),
        cwd: s.cwd,
        model: s.model,
        updatedAt: s.updatedAt ?? s.createdAt ?? 0,
        messageCount: s.messages.filter((m) => m.role !== "system").length,
      });
    } catch {
      // Skip a corrupt file rather than failing the whole listing.
    }
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return opts?.limit ? out.slice(0, opts.limit) : out;
}

/** Most recently updated session for a directory, for `--continue`. */
export function latestSession(cwd: string): StoredSession | null {
  const [first] = listSessions({ cwd, limit: 1 });
  return first ? loadSession(first.id) : null;
}

export interface RecentProject {
  cwd: string;
  /** Sessions recorded against this directory. */
  sessions: number;
  /** When it was last worked in. */
  updatedAt: number;
  /** False once the directory has been moved or deleted. */
  exists: boolean;
}

/**
 * Directories worked in before, newest first.
 *
 * Derived from the session list rather than a separate recents file, so it
 * cannot drift out of sync with what `/sessions` shows. Directories that no
 * longer exist are kept and flagged — a project that moved is exactly what
 * someone needs to see explained, not silently dropped from the list.
 */
export function recentProjects(limit = 12): RecentProject[] {
  const byDir = new Map<string, RecentProject>();
  for (const s of listSessions()) {
    const dir = path.resolve(s.cwd);
    const found = byDir.get(dir);
    if (found) {
      found.sessions++;
      found.updatedAt = Math.max(found.updatedAt, s.updatedAt);
      continue;
    }
    let exists = false;
    try {
      exists = fs.statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    byDir.set(dir, { cwd: dir, sessions: 1, updatedAt: s.updatedAt, exists });
  }
  return [...byDir.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function firstUserLine(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && !m.content.startsWith("<onflip:result"));
  if (!first) return "(empty session)";
  return first.content.split("\n")[0].slice(0, 80);
}

/** Derive a short title from the opening exchange, once, for the session list. */
export function deriveTitle(session: StoredSession): string {
  if (session.title) return session.title;
  return firstUserLine(session.messages);
}

/** Human-friendly relative timestamp for the session picker. */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
