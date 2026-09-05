import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { cronError, describeCron, nextRunOf } from "../shared/cron";
import type { ScheduleDTO } from "../shared/protocol";

/**
 * Prompts that send themselves, on a schedule.
 *
 * The whole feature is one idea: a saved prompt, a cron expression, and a
 * working directory. When the time comes the prompt is handed to that
 * project's engine exactly as if it had been typed into the composer — so
 * everything downstream (queueing behind a running turn, approvals, the
 * transcript) is the behaviour that already exists rather than a second path
 * that has to be kept in step with it.
 *
 * It lives in the main process because that is what outlives any one window:
 * a schedule set up in a window that has since been closed still has to run,
 * and two windows must not each fire the same one.
 */

/** One tick a minute, on the minute — cron's own resolution. */
const TICK_MS = 15_000;

/**
 * How late a run may be and still count as due.
 *
 * A laptop that slept through 3am should not wake up and fire yesterday's
 * schedule as though nothing happened, and an app started on Monday should
 * not replay every overnight run from the weekend. Anything older than this
 * is recorded as missed and skipped. Two minutes covers a tick landing late
 * under load without covering a lid being shut.
 */
const GRACE_MS = 2 * 60_000;

export interface StoredSchedule {
  id: string;
  /** What gets sent, verbatim. */
  prompt: string;
  cron: string;
  /** The project it runs in; the window on that folder is the one used. */
  cwd: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "sent" | "queued" | "missed" | "failed";
  lastDetail?: string;
}

let schedules: StoredSchedule[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let loaded = false;
/** Minutes already fired, so a tick landing twice in one minute cannot double-send. */
const firedAt = new Map<string, number>();

function file(): string {
  return path.join(app.getPath("userData"), "schedules.json");
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    // A byte-order mark is not JSON, and every Windows tool that has ever
    // rewritten a file by hand leaves one.
    const raw = fs.readFileSync(file(), "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw) as unknown;
    schedules = Array.isArray(parsed) ? (parsed as StoredSchedule[]).filter(valid) : [];
  } catch {
    schedules = [];
  }
}

function valid(s: unknown): s is StoredSchedule {
  const o = s as StoredSchedule;
  return Boolean(o && typeof o.id === "string" && typeof o.prompt === "string" && typeof o.cron === "string");
}

function persist(): void {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(schedules, null, 2));
  } catch {
    /* best-effort: a schedule that cannot be saved still runs this session */
  }
}

/** The shape the renderer lists, with the next run worked out for it. */
function toDTO(s: StoredSchedule): ScheduleDTO {
  const next = s.enabled ? nextRunOf(s.cron) : null;
  return {
    id: s.id,
    prompt: s.prompt,
    cron: s.cron,
    description: describeCron(s.cron),
    cwd: s.cwd,
    enabled: s.enabled,
    createdAt: s.createdAt,
    nextRunAt: next ? next.getTime() : undefined,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    lastDetail: s.lastDetail,
  };
}

export function listSchedules(): ScheduleDTO[] {
  load();
  return [...schedules]
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map(toDTO);
}

export function createSchedule(input: {
  prompt: string;
  cron: string;
  cwd: string;
}): { ok: true; schedule: ScheduleDTO } | { ok: false; error: string } {
  load();
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, error: "Enter the prompt to send." };
  const bad = cronError(input.cron);
  if (bad) return { ok: false, error: bad };

  const schedule: StoredSchedule = {
    id: randomUUID(),
    prompt,
    cron: input.cron.trim(),
    cwd: input.cwd,
    enabled: true,
    createdAt: Date.now(),
  };
  schedules.push(schedule);
  persist();
  return { ok: true, schedule: toDTO(schedule) };
}

export function updateSchedule(
  id: string,
  patch: { prompt?: string; cron?: string; enabled?: boolean }
): { ok: true; schedule: ScheduleDTO } | { ok: false; error: string } {
  load();
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) return { ok: false, error: "That schedule is gone." };
  if (patch.cron !== undefined) {
    const bad = cronError(patch.cron);
    if (bad) return { ok: false, error: bad };
    schedule.cron = patch.cron.trim();
  }
  if (patch.prompt !== undefined) {
    const prompt = patch.prompt.trim();
    if (!prompt) return { ok: false, error: "Enter the prompt to send." };
    schedule.prompt = prompt;
  }
  if (patch.enabled !== undefined) schedule.enabled = patch.enabled;
  persist();
  return { ok: true, schedule: toDTO(schedule) };
}

export function deleteSchedule(id: string): boolean {
  load();
  const before = schedules.length;
  schedules = schedules.filter((s) => s.id !== id);
  if (schedules.length === before) return false;
  firedAt.delete(id);
  persist();
  return true;
}

/**
 * Which schedules are due at `now`, and which are too late to bother with.
 *
 * Pure, and separated from the sending for exactly that reason: "did this
 * one already run this minute" and "is this one so late it should be
 * skipped" are the two things a scheduler gets wrong, and neither is
 * testable through a timer.
 */
export function due(
  all: StoredSchedule[],
  now: number,
  alreadyFired: Map<string, number>
): { run: StoredSchedule[]; missed: StoredSchedule[] } {
  const run: StoredSchedule[] = [];
  const missed: StoredSchedule[] = [];
  for (const schedule of all) {
    if (!schedule.enabled) continue;
    // Look back from now for the run that should most recently have
    // happened: comparing against the *next* run would only ever fire on the
    // exact millisecond, which no timer guarantees.
    const since = schedule.lastRunAt ?? schedule.createdAt ?? now;
    const previous = lastDueBefore(schedule.cron, since, now);
    if (previous === null) continue;
    // The same minute twice is a tick that landed twice, not two runs.
    if (alreadyFired.get(schedule.id) === previous) continue;
    if (now - previous > GRACE_MS) missed.push(schedule);
    else run.push(schedule);
  }
  return { run, missed };
}

/**
 * The most recent firing time at or before `now` that comes after `after`.
 *
 * Walked forward from `after` rather than backward from `now`, because
 * "the previous occurrence" has no closed form and stepping forward from a
 * known point is the only way to get it right for every field shape.
 */
function lastDueBefore(cron: string, after: number, now: number): number | null {
  let cursor = new Date(after);
  let found: number | null = null;
  // A generous ceiling on iterations: a per-minute schedule left alone for a
  // day is 1,440 steps, and beyond that the answer is "missed" anyway.
  for (let i = 0; i < 2_000; i++) {
    const next = nextRunOf(cron, cursor);
    if (!next || next.getTime() > now) break;
    found = next.getTime();
    cursor = next;
  }
  return found;
}

/** How a fired schedule turned out, so the list can show it. */
export type FireResult = { status: "sent" | "queued" | "failed"; detail?: string };

/** Hands a prompt to the right window's engine. Set by the main process. */
export type Sender = (schedule: StoredSchedule) => Promise<FireResult>;

let send: Sender | null = null;
/** Told after every change, so an open list refreshes itself. */
let onChange: (() => void) | null = null;

export function startScheduler(sender: Sender, changed: () => void): void {
  load();
  send = sender;
  onChange = changed;
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  // Not on startup: the app is still opening its window and connecting its
  // engine, and a prompt sent into that would be sent into nothing.
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  load();
  const now = Date.now();
  const { run, missed } = due(schedules, now, firedAt);
  if (!run.length && !missed.length) return;

  for (const schedule of missed) {
    firedAt.set(schedule.id, now);
    schedule.lastRunAt = now;
    schedule.lastStatus = "missed";
    schedule.lastDetail = "OnFlip was not running at the time.";
  }

  for (const schedule of run) {
    firedAt.set(schedule.id, now);
    schedule.lastRunAt = now;
    try {
      const result = send ? await send(schedule) : { status: "failed" as const, detail: "No sender." };
      schedule.lastStatus = result.status;
      schedule.lastDetail = result.detail;
    } catch (e) {
      schedule.lastStatus = "failed";
      schedule.lastDetail = e instanceof Error ? e.message : String(e);
    }
  }
  persist();
  onChange?.();
}

/** Fire one now, by hand, from the list. */
export async function runScheduleNow(id: string): Promise<FireResult> {
  load();
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) return { status: "failed", detail: "That schedule is gone." };
  schedule.lastRunAt = Date.now();
  try {
    const result = send ? await send(schedule) : { status: "failed" as const, detail: "No sender." };
    schedule.lastStatus = result.status;
    schedule.lastDetail = result.detail;
    persist();
    onChange?.();
    return result;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    schedule.lastStatus = "failed";
    schedule.lastDetail = detail;
    persist();
    onChange?.();
    return { status: "failed", detail };
  }
}
