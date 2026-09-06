import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
  screen,
  Tray,
  Menu,
  IpcMainInvokeEvent,
  IpcMainEvent,
} from "electron";
import { Notification } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Peer } from "../shared/wire";
import { runSignIn, clearSignIn } from "./signin";
import { guardWebContents } from "./chrome-identity";
import {
  embeddedEnv,
  enableEmbeddedBrowser,
  ensureView,
  hideView,
  resolveEndpoint,
  setViewBounds,
  actOnView,
  navigateView,
  viewChrome,
  externalTarget,
  watchViewChrome,
  type ViewAction,
} from "./browser-view";
import { checkForUpdate } from "./updates";
import {
  applyUpdate,
  downloadUpdate,
  startUpdateWatch,
  type UpdateProgress,
} from "./update-install";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  startScheduler,
  updateSchedule,
  type FireResult,
  type StoredSchedule,
} from "./schedules";
import {
  saveTelegram,
  startTelegram,
  telegramApprovalDone,
  telegramAskApproval,
  telegramOnEvent,
  telegramPublic,
  telegramSendFile,
} from "./telegram";
import {
  applyIndicator,
  indicatorSettings,
  setIndicatorState,
  startIndicator,
  type IndicatorState,
} from "./indicator";
import {
  activeProvider,
  providerLabel,
  isProviderId,
  PROVIDER_IDS,
} from "onflip/dist/providers/id";
import { saveConfig } from "onflip/dist/config";
import type { ApprovalDecisionDTO, EngineStatus } from "../shared/protocol";

/**
 * The Electron main process is deliberately thin: it owns windows and their
 * engine children, and relays messages between each renderer and its engine.
 * All agent behaviour lives in the engine, which runs the OnFlip core under
 * plain Node — the same runtime the CLI uses, so everything behaves
 * identically.
 *
 * One window, one engine. That pairing is what makes two sessions genuinely
 * concurrent: each window's engine has its own browser, its own working
 * directory and its own running turn, the way two ChatGPT tabs are two
 * conversations. The processes share nothing but the account — and the
 * account-level state that must be shared (the session cookies, the send
 * cooldown) already lives in ~/.onflip where every engine reads it.
 */

interface Workspace {
  win: BrowserWindow;
  engine: ChildProcess | null;
  peer: Peer | null;
  engineExited: boolean;
  /** The built-in terminal's running command, one per window. */
  termChild: ChildProcess | null;
  /** The turn's final answer or question so far, for the notification that ends it. */
  lastFinal?: { kind: "assistant" | "question"; text: string };
  /** The project this window is on, as its engine last reported it. */
  cwd?: string;
  /** The engine's last status, so the bot can answer /status instantly. */
  lastStatus?: EngineStatus;
  /** Whether a turn is running here, for the status widget. */
  busy?: boolean;
}

// ---------------------------------------------------------------------------
// system notifications
// ---------------------------------------------------------------------------

/**
 * A toast when something happened that the person is not looking at.
 *
 * A turn can run for minutes, and the whole point of an agent is not having
 * to watch it; Codex and Claude's apps both tap you on the shoulder when
 * the work is done or needs you. Shown only while the window is hidden,
 * minimised or behind something else — a toast over a window you are
 * reading is noise — and worded in the interface language the renderer
 * reported. Clicking it brings that window forward.
 */
type NoticeKind = "finished" | "question" | "approval" | "error" | "exhausted";

const NOTICE_TITLES: Record<string, Record<NoticeKind, string>> = {
  en: {
    finished: "OnFlip finished the task",
    question: "OnFlip needs your decision",
    approval: "OnFlip needs your approval",
    error: "OnFlip stopped with an error",
    exhausted: "OnFlip stopped early",
  },
  ru: {
    finished: "OnFlip завершил задачу",
    question: "OnFlip ждёт вашего решения",
    approval: "OnFlip ждёт вашего разрешения",
    error: "OnFlip остановился с ошибкой",
    exhausted: "OnFlip остановился раньше времени",
  },
  uz: {
    finished: "OnFlip vazifani tugatdi",
    question: "OnFlip sizning qaroringizni kutmoqda",
    approval: "OnFlip sizning ruxsatingizni kutmoqda",
    error: "OnFlip xato bilan to'xtadi",
    exhausted: "OnFlip erta to'xtadi",
  },
};

/** Markdown and line breaks stripped, cut to what a toast can show. */
function toastLine(text: string, max = 160): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function notifyAway(ws: Workspace, kind: NoticeKind, body: string): void {
  try {
    const state = loadState();
    if (state.notifications === false) return;
    if (!Notification.isSupported()) return;
    const win = ws.win;
    if (win.isDestroyed()) return;
    const away = !win.isVisible() || win.isMinimized() || !win.isFocused();
    if (!away) return;
    const lang = state.language && NOTICE_TITLES[state.language] ? state.language : "en";
    const toast = new Notification({
      title: NOTICE_TITLES[lang][kind],
      body: toastLine(body),
      icon: appIcon(),
    });
    toast.on("click", () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    toast.show();
  } catch (e) {
    // A notification that cannot be shown is not worth a failed turn.
    console.error("[desktop] notification failed:", e instanceof Error ? e.message : String(e));
  }
}

const workspaces = new Map<number, Workspace>();
/** The window most recently focused — where the tray and dock actions go. */
let lastActiveId: number | null = null;
let tray: Tray | null = null;
/** Set once the user chose Quit; before that, closing the last window hides it. */
let quitting = false;
/** An update is downloading or installing — a second click must not start another. */
let updating = false;
/**
 * The app is quitting to be replaced, so the tray must not keep it alive.
 *
 * Closing the last window normally hides to tray, which for an update would
 * leave the old version running while the installer tries to overwrite it.
 */
let quittingForUpdate = false;

function appIcon(): string {
  return path.join(__dirname, "..", "..", "buildResources", "icon.ico");
}

/** The workspace an IPC message came from. */
function wsOf(e: IpcMainInvokeEvent | IpcMainEvent): Workspace | null {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? (workspaces.get(win.id) ?? null) : null;
}

/**
 * What the status widget should be showing, across every window.
 *
 * One widget for the whole app, so the states are combined worst-first:
 * anything waiting on a person beats anything merely running, because that
 * is the state where looking at the screen is actually urgent.
 */
function refreshIndicator(): void {
  let state: IndicatorState = "idle";
  for (const ws of workspaces.values()) {
    if (approvalPendingFor(ws) || ws.lastFinal?.kind === "question") {
      state = "waiting";
      break;
    }
    if (ws.busy) state = "working";
  }
  setIndicatorState(state);
}

function approvalPendingFor(ws: Workspace): boolean {
  for (const waiter of approvalWaiters.values()) if (waiter.ws === ws) return true;
  return false;
}

/** The project a window is on, if its engine has reported one yet. */
function currentCwd(ws: Workspace | null): string | undefined {
  return ws?.cwd;
}

/** Same folder, allowing for slash direction and case on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\/]+$/, "").toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Send a scheduled prompt into the window that is on its project.
 *
 * Handed to the engine through the same `send` every typed message uses, so
 * a schedule landing mid-turn queues behind it, gets its approvals and lands
 * in the transcript exactly like anything else — rather than through a
 * second path that would have to be kept in step with the first.
 */
async function fireSchedule(schedule: StoredSchedule): Promise<FireResult> {
  let target: Workspace | null = null;
  for (const ws of workspaces.values()) {
    if (ws.peer && !ws.engineExited && samePath(ws.cwd ?? "", schedule.cwd)) {
      target = ws;
      break;
    }
  }
  if (!target) {
    // Deliberately not opening a window for it. A prompt sent into a window
    // nobody asked for, on a project nobody has open, is an agent running
    // unattended somewhere the user is not looking.
    return {
      status: "failed",
      detail: `No window is open on ${schedule.cwd}.`,
    };
  }
  const reply = (await target.peer!.request("send", { text: schedule.prompt })) as {
    queued?: boolean;
  };
  if (!target.win.isDestroyed()) {
    sendTo(target, "engine-event", {
      event: "item",
      data: {
        type: "notice",
        id: randomUUID(),
        text: `Scheduled prompt sent: ${schedule.cron}`,
      },
    });
  }
  return { status: reply?.queued ? "queued" : "sent" };
}

/**
 * The window the Telegram bot is driving.
 *
 * Mirroring used to be gated on `ws === frontWorkspace()`, which dropped a
 * turn's output the moment the window lost focus — including part-way
 * through — and interleaved two windows' work when both were busy. The bot
 * binds to whichever window it last acted on and stays there.
 */
let telegramWs: Workspace | null = null;

function telegramTarget(): Workspace | null {
  if (telegramWs && workspaces.has(telegramWs.win.id) && !telegramWs.win.isDestroyed()) {
    return telegramWs;
  }
  telegramWs = frontWorkspace();
  return telegramWs;
}

/** The workspace the user is looking at, or the likeliest one. */
function frontWorkspace(): Workspace | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && workspaces.has(focused.id)) return workspaces.get(focused.id)!;
  if (lastActiveId !== null && workspaces.has(lastActiveId)) return workspaces.get(lastActiveId)!;
  for (const ws of workspaces.values()) return ws;
  return null;
}

// ---------------------------------------------------------------------------
// small persistent state of the shell itself (not the agent)
// ---------------------------------------------------------------------------

interface DesktopState {
  lastCwd?: string;
  bounds?: { x?: number; y?: number; width: number; height: number };
  maximized?: boolean;
  /** System notifications when a turn ends or needs the user; on unless switched off. */
  notifications?: boolean;
  /** The renderer's interface language, so notifications are worded in it. */
  language?: string;
}

/**
 * Saved bounds are trusted only while they land on a display that is still
 * attached. A window last closed on a monitor that has since been unplugged
 * came back entirely off-screen — running, in the taskbar, and unreachable
 * without deleting the state file by hand. Position is dropped and the size
 * kept, so the window centres itself at the size the user chose.
 */
function onScreenBounds(bounds: DesktopState["bounds"]): DesktopState["bounds"] | undefined {
  if (!bounds) return undefined;
  const { x, y, width, height } = bounds;
  if (x === undefined || y === undefined) return { width, height };
  const grabbable = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    // Enough of the title bar inside the work area to take hold of.
    return x + width - 80 > a.x && x + 80 < a.x + a.width && y + 40 > a.y && y + 40 < a.y + a.height;
  });
  return grabbable ? bounds : { width, height };
}

/**
 * Where an engine may start.
 *
 * The saved "last project" can name a folder that has since been deleted or
 * renamed, and Windows reports a missing working directory on spawn as
 * ENOENT — the same error as a missing executable. That one error used to
 * send `startEngine` round its own Node-then-Electron fallback forever, on
 * every tick, and the window was never drawn: the app was running and could
 * not be opened. So the folder is checked here, before anything is spawned,
 * and a missing one falls back to home and says so.
 */
function engineCwd(requested?: string): { cwd: string; missing?: string } {
  const wanted = requested || loadState().lastCwd;
  if (wanted) {
    try {
      if (fs.statSync(wanted).isDirectory()) return { cwd: wanted };
    } catch {
      /* gone, or not a directory — fall through */
    }
  }
  // The state file is a convenience copy of something the engine's own
  // session files already record. When it is missing or unreadable, the
  // folder the user last actually worked in is still the right place to
  // start, not their home directory.
  const remembered = latestSessionCwd();
  if (remembered) return { cwd: remembered, missing: wanted && wanted !== remembered ? wanted : undefined };
  const home = os.homedir();
  return { cwd: home, missing: wanted && wanted !== home ? wanted : undefined };
}

/** The working directory of the most recently saved session that still exists. */
function latestSessionCwd(): string | null {
  try {
    const dir = path.join(os.homedir(), ".onflip", "sessions");
    const candidates = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);
    for (const { file } of candidates) {
      try {
        const cwd = (JSON.parse(fs.readFileSync(file, "utf8")) as { cwd?: string }).cwd;
        if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
      } catch {
        /* a corrupt or stale record; try the next */
      }
    }
  } catch {
    /* no sessions yet */
  }
  return null;
}

function stateFile(): string {
  return path.join(app.getPath("userData"), "desktop-state.json");
}

function loadState(): DesktopState {
  try {
    // A byte-order mark is not JSON. PowerShell's `Set-Content -Encoding
    // utf8` writes one, and a hand-edited state file read as empty lost the
    // window bounds and the last project on the next save.
    const raw = fs.readFileSync(stateFile(), "utf8").replace(/^﻿/, "");
    return JSON.parse(raw) as DesktopState;
  } catch {
    return {};
  }
}

function saveState(patch: Partial<DesktopState>): void {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }, null, 2));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// engine child
// ---------------------------------------------------------------------------

function engineEntry(): string {
  return path.join(__dirname, "..", "engine", "host.js");
}

/**
 * Plain Node is preferred: better-sqlite3's default binding is built for the
 * Node ABI, and everything is exactly the CLI. `ELECTRON_RUN_AS_NODE` is the
 * fallback when no system Node is installed — the core carries a second
 * sqlite binding for the Electron ABI (onflip/prebuilds), so even browser
 * cookie import works there now.
 */
function spawnEngine(cwd: string): ChildProcess {
  const entry = engineEntry();
  const args = [entry, "--cwd", cwd];
  const nodeBin = process.env.ONFLIP_NODE || "node";
  // The engine runs under plain Node, so it cannot find Electron by itself —
  // and the cookie worker needs Electron, whose ABI matches the sqlite
  // binding this app ships. Handing the path down is what makes the reader
  // work on a machine whose own Node was built against a different ABI.
  // ONFLIP_EMBEDDED_* is how the engine finds the view to drive. Absent
  // when the DevTools port never opened, and the engine then launches a
  // browser of its own exactly as it used to.
  const env = { ...process.env, ONFLIP_ELECTRON_PATH: process.execPath, ...embeddedEnv() };
  try {
    const child = spawn(nodeBin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    // ENOENT arrives as an async error; handled by the caller's error hook.
    return child;
  } catch {
    return spawnEngineViaElectron(args, cwd);
  }
}

function spawnEngineViaElectron(args: string[], cwd: string): ChildProcess {
  return spawn(process.execPath, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...embeddedEnv() },
  });
}

function sendTo(ws: Workspace, channel: string, payload: unknown): void {
  if (!ws.win.isDestroyed()) ws.win.webContents.send(channel, payload);
}

/**
 * Everything the engines print to stderr, kept on disk.
 *
 * It used to go only to the renderer's debug panel, which is how an engine
 * death took its evidence with it: the process vanished mid-turn with nothing
 * in any log, because the one channel that carries a native crash or an
 * out-of-memory abort — stderr — was never persisted. JS-level failures are
 * caught and survive; the ones that kill a process outright only ever say why
 * here. One shared file across windows; the pid in each marker tells the
 * engines apart.
 */
function engineStderrLog(pid: number | undefined): fs.WriteStream | null {
  try {
    const file = path.join(app.getPath("userData"), "engine-stderr.log");
    // Fresh engine, bounded file. Rotated rather than deleted: the renderer
    // restarts a dead engine within a second, so deleting here would throw
    // away the crash's own stderr on the restart that follows it — exactly
    // the evidence this file exists to keep.
    try {
      if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.1`);
    } catch {
      /* first run */
    }
    const stream = fs.createWriteStream(file, { flags: "a" });
    stream.write(`\n--- engine pid ${pid ?? "?"} started ${new Date().toISOString()} ---\n`);
    return stream;
  } catch {
    return null;
  }
}

function startEngine(ws: Workspace, requested?: string): void {
  const { cwd, missing } = engineCwd(requested);
  ws.engineExited = false;
  let child = spawnEngine(cwd);
  const stderrLog = engineStderrLog(child.pid);
  // One fallback, then the failure is final. The retry used to key on
  // `c === child` alone, which the fallback satisfied too, so a second
  // ENOENT re-entered it from its own error handler on every tick.
  let fellBack = false;

  const wire = new Peer((chunk) => {
    // Writing after the pipe is gone raises `error` on stdin, and with nobody
    // listening that is an uncaught exception in the main process — a stale
    // approval answered after a restart was enough to bring the dialog up.
    if (child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable) return;
    child.stdin.write(chunk);
  });
  ws.peer = wire;

  const fail = (detail: string) => {
    ws.engineExited = true;
    wire.close(detail);
    sendTo(ws, "engine-event", { event: "connect", data: { state: "error", detail } });
    sendTo(ws, "engine-exit", { code: null });
  };

  const attach = (c: ChildProcess) => {
    c.stdin?.on("error", () => {
      /* EPIPE after the engine died; the exit handler is what reports that */
    });
    c.stdout?.on("data", (chunk: Buffer) => wire.feed(chunk));
    c.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderrLog?.write(chunk);
      } catch {
        /* the copy on disk is best-effort */
      }
      sendTo(ws, "engine-event", { event: "log", data: { line: chunk.toString("utf8") } });
    });
    c.on("error", (e: NodeJS.ErrnoException) => {
      if (c !== child) return;
      // No system Node — retry once inside Electron's own Node.
      if (e.code === "ENOENT" && !fellBack) {
        fellBack = true;
        const fallback = spawnEngineViaElectron([engineEntry(), "--cwd", cwd], cwd);
        child = fallback;
        ws.engine = fallback;
        attach(fallback);
        return;
      }
      // A spawn that fails emits `error` and never `exit`, so everything the
      // exit handler would do has to happen here, or the renderer waits on
      // an `init` that no process will ever answer.
      fail(`Engine failed to start: ${e.message}`);
    });
    c.on("exit", (code) => {
      if (c !== child) return;
      ws.engineExited = true;
      try {
        stderrLog?.write(
          `--- engine pid ${c.pid ?? "?"} exited ${new Date().toISOString()} code ${code ?? "unknown"} ---\n`
        );
        stderrLog?.end();
      } catch {
        /* best-effort */
      }
      wire.close(`The engine exited (code ${code ?? "unknown"}).`);
      sendTo(ws, "engine-exit", { code });
    });
  };
  attach(child);
  ws.engine = child;

  let explainedMissing = false;
  wire.onEvent = (event, data) => {
    if (event === "status") {
      const status = data as EngineStatus;
      ws.lastStatus = status;
      if (status.cwd) {
        // Remembered per window as well as globally: a scheduled prompt has
        // to reach the window on *its* project, not whichever was last used.
        ws.cwd = status.cwd;
        saveState({ lastCwd: status.cwd });
      }
      // Told once, after the engine's first status: by then the renderer has
      // its transcript, so the note lands on screen instead of under it.
      if (missing && !explainedMissing) {
        explainedMissing = true;
        sendTo(ws, "engine-event", {
          event: "item",
          data: {
            type: "notice",
            id: `missing-project-${Date.now()}`,
            text: `The last project folder, ${missing}, no longer exists — opened your home folder instead.`,
          },
        });
      }
    }
    // The engine has stopped waiting for these; an answer arriving later
    // must not be credited to a prompt that is no longer open.
    if (event === "approval-cancelled") {
      for (const [id, waiter] of approvalWaiters) {
        if (waiter.ws === ws) approvalWaiters.delete(id);
      }
    }
    // What the turn ended with arrives as an item before the turn-end event;
    // kept so the toast for the end can quote it. A question is announced
    // as itself, and not again when the turn ends on it.
    if (event === "item") {
      const item = data as { type?: string; text?: string };
      if (item.type === "assistant" || item.type === "question") {
        ws.lastFinal = { kind: item.type, text: item.text ?? "" };
      }
      if (item.type === "question") notifyAway(ws, "question", item.text ?? "");
    }
    if (event === "turn") {
      const turn = data as { state?: string; interrupted?: boolean; exhausted?: boolean; error?: string };
      if (turn.state === "start") {
        ws.lastFinal = undefined;
        ws.busy = true;
      } else if (turn.state === "end" && !turn.interrupted) {
        if (turn.exhausted) notifyAway(ws, "exhausted", turn.error ?? "");
        else if (turn.error) notifyAway(ws, "error", turn.error);
        else if (ws.lastFinal?.kind !== "question") notifyAway(ws, "finished", ws.lastFinal?.text ?? "");
      }
    }
    if (event === "turn" && (data as { state?: string }).state === "end") ws.busy = false;
    refreshIndicator();
    // The bot mirrors whichever window it is driving. Fire-and-forget:
    // a Telegram hiccup must never hold up the renderer's own update.
    if (ws === telegramTarget()) void telegramOnEvent(event, data);
    sendTo(ws, "engine-event", { event, data });
  };

  // The engine's own requests — approvals — go to this window and wait there.
  wire.onRequest = async (method, params) => {
    if (method === "approval") {
      return await askRendererForApproval(ws, params);
    }
    if (method === "telegram-file") {
      const p = (params ?? {}) as { file?: string; caption?: string };
      return await telegramSendFile(String(p.file ?? ""), p.caption);
    }
    throw new Error(`Unknown engine->app request: ${method}`);
  };

  wire.onNoise = (line) => {
    sendTo(ws, "engine-event", { event: "log", data: { line } });
  };
}

// Pending approval prompts, answered by the renderers. Ids are global so a
// response cannot be credited to the wrong window's prompt.
let nextApprovalId = 1;
interface ApprovalWaiter {
  ws: Workspace;
  request: unknown;
  resolve: (d: ApprovalDecisionDTO) => void;
}
const approvalWaiters = new Map<number, ApprovalWaiter>();

function askRendererForApproval(ws: Workspace, request: unknown): Promise<ApprovalDecisionDTO> {
  const id = nextApprovalId++;
  return new Promise<ApprovalDecisionDTO>((resolve) => {
    approvalWaiters.set(id, { ws, request, resolve });
    sendTo(ws, "approval-request", { id, request });
    // Also to the phone, when the bot is driving this window. Without it a
    // turn on "ask" simply stopped there, with no message and no way to
    // answer — which made the remote usable only in full-auto, the least
    // supervised mode there is.
    if (ws === telegramTarget()) telegramAskApproval(id, request);
    refreshIndicator();
    // Judged before the window is brought forward: on Windows a background
    // window asked to focus usually only flashes in the taskbar, and the
    // toast is what actually reaches the person.
    const ask = (request ?? {}) as { tool?: string; subject?: string; reason?: string };
    notifyAway(ws, "approval", [ask.tool, ask.subject].filter(Boolean).join(": ") || ask.reason || "");
    if (!ws.win.isDestroyed()) {
      ws.win.show();
      ws.win.focus();
    }
  });
}

/**
 * Put the prompts a window still owes back on its screen.
 *
 * A reload forgets the modal but not the engine's question: the turn sat in
 * `awaitingApproval`, which pauses the silence watchdog, so it waited for
 * ever. Re-sent when the fresh renderer asks for `init`, which is the one
 * moment it is certainly listening.
 */
function resendApprovals(ws: Workspace): void {
  for (const [id, waiter] of approvalWaiters) {
    if (waiter.ws === ws) sendTo(ws, "approval-request", { id, request: waiter.request });
  }
}

async function stopEngine(ws: Workspace): Promise<void> {
  const child = ws.engine;
  if (!child) return;
  ws.engine = null;
  const wire = ws.peer;
  ws.peer = null;
  wire?.close("The engine is restarting.");
  for (const [id, waiter] of approvalWaiters) {
    if (waiter.ws === ws) approvalWaiters.delete(id);
  }
  // Already dead, or never started (no pid) — after a crash the renderer's
  // own restart used to sit through the full grace period waiting for an
  // exit that had happened, or that a failed spawn would never send.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin?.end();
  } catch {
    /* already gone */
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve();
    }, 4_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

function createWindow(cwd?: string): Workspace {
  const state = loadState();
  const bounds = onScreenBounds(state.bounds);
  nativeTheme.themeSource = "dark";

  // Later windows cascade off the saved bounds rather than stacking exactly
  // on top of the first.
  const offset = workspaces.size * 28;

  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 840,
    x: bounds?.x !== undefined ? bounds.x + offset : undefined,
    y: bounds?.y !== undefined ? bounds.y + offset : undefined,
    minWidth: 760,
    minHeight: 520,
    show: false,
    icon: path.join(__dirname, "..", "..", "buildResources", "icon.ico"),
    backgroundColor: "#0d0d0d",
    // Window controls belong to the platform. On Windows the renderer draws
    // its own minimise/maximise/close over a frameless window, which is what
    // that platform's apps look like. macOS has one shape of window button
    // and every app wears it, so the real traffic lights are kept and only
    // the title bar is hidden — a Mac app with Windows-style controls in the
    // corner reads as a port, which is exactly what users said.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const ws: Workspace = { win, engine: null, peer: null, engineExited: false, termChild: null };
  workspaces.set(win.id, ws);
  lastActiveId = win.id;
  win.on("focus", () => {
    lastActiveId = win.id;
  });

  // Shown when the first frame is ready — or after five seconds regardless.
  // `ready-to-show` never fires for a page that failed to load, and a window
  // that is never shown is indistinguishable from an app that did not start.
  // A blank window with the debug log is something a person can act on.
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    if (state.maximized && workspaces.size === 1) win.maximize();
  };
  const revealAnyway = setTimeout(reveal, 5_000);
  win.once("ready-to-show", () => {
    clearTimeout(revealAnyway);
    reveal();
  });
  // The renderer is the app itself: the only navigation it makes is its own
  // load. Anything else — a file dropped somewhere other than the composer,
  // a link the page did not catch — would replace the app with that page,
  // and the preload's bridge (a terminal, among other things) would be
  // handed to it.
  const devServer = process.env.VITE_DEV_SERVER_URL;
  win.webContents.on("will-navigate", (e, url) => {
    if (devServer && url.startsWith(devServer)) return;
    e.preventDefault();
  });
  // Reload is not a thing this app can afford, and the keys for it are on
  // everyone's fingers. Dropping the application menu took the menu's own
  // accelerators away but not these: Ctrl+F5 still threw away the window
  // mid-turn — the transcript, the running approval prompt, the lot — while
  // the engine carried on working for a renderer that no longer existed.
  // Swallowed at the input event because that catches every route to it,
  // rather than only the one the menu owned.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const reload =
      key === "f5" ||
      ((input.control || input.meta) && (key === "r" || key === "f5")) ||
      // Chromium's own hard-reload pair.
      ((input.control || input.meta) && input.shift && key === "r");
    if (reload) event.preventDefault();
  });
  // Created with the window rather than when the panel first opens: the
  // agent can be told to browse before anybody has looked at the panel, and
  // the page has to exist for the engine to find it over CDP. A parked view
  // is a blank about-page with zero bounds — cheap, and far cheaper than the
  // whole second Chromium this replaces.
  ensureView(win);
  // The toolbar mirrors the view, so it has to hear about every navigation
  // — including the ones the agent makes, which is most of them.
  watchViewChrome(win, () => sendTo(ws, "browser-chrome", viewChrome(win)));

  // The custom maximise button swaps its glyph with the real window state.
  win.on("maximize", () => sendTo(ws, "win-state", { maximized: true }));
  win.on("unmaximize", () => sendTo(ws, "win-state", { maximized: false }));
  // Surface renderer logs on stdout when launched with ONFLIP_DESKTOP_DEBUG,
  // so a headless launch (CI, a terminal) can see what the window sees.
  if (process.env.ONFLIP_DESKTOP_DEBUG) {
    win.webContents.on("console-message", (_e, level, message) => {
      process.stdout.write(`[renderer:${level}] ${message}\n`);
    });
    win.webContents.on("did-finish-load", () => process.stdout.write("[window] loaded\n"));
    win.webContents.on("preload-error", (_e, p, error) => {
      process.stdout.write(`[preload-error] ${p}: ${error.message}\n`);
    });
  }
  // Debug aid: capture the window to a PNG a few seconds after load, so a
  // headless launch can be verified without eyes on the screen.
  const shot = process.env.ONFLIP_DESKTOP_SHOT;
  if (shot && workspaces.size === 1) {
    win.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        void win.webContents.capturePage().then((image) => {
          fs.writeFileSync(shot, image.toPNG());
          process.stdout.write(`[shot] ${shot}\n`);
        });
      }, 9_000);
    });
  }
  // Closing the last window keeps OnFlip alive in the tray — its engine (and
  // any running turn) carries on in the background, the way Codex does it.
  // Closing one of several windows really closes it: that window's engine is
  // its own, and a hidden window nobody can reopen would keep it alive
  // invisibly.
  win.on("close", (e) => {
    if (win.isDestroyed()) return;
    // The normal bounds, not the current ones: a maximised window reports
    // the whole screen, and a minimised one reports -32000,-32000 on
    // Windows — saved as-is, either restores a window nobody can find.
    if (!win.isMinimized()) {
      saveState({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    }
    // Hiding to tray on an update would leave the old version running while
    // the installer tries to overwrite it — on Windows that is a locked file
    // and a failed update.
    if (!quitting && !quittingForUpdate && workspaces.size <= 1) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    workspaces.delete(win.id);
    if (lastActiveId === win.id) lastActiveId = null;
    if (ws.termChild) killTree(ws.termChild);
    void stopEngine(ws);
  });

  // External links open in the user's real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(path.join(__dirname, "..", "..", "ui-dist", "index.html"));

  startEngine(ws, cwd);
  return ws;
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

function showWindow(): void {
  const ws = frontWorkspace();
  if (!ws || ws.win.isDestroyed()) {
    createWindow();
    return;
  }
  if (ws.win.isMinimized()) ws.win.restore();
  ws.win.show();
  ws.win.focus();
}

function createTray(): void {
  tray = new Tray(appIcon());
  tray.setToolTip("OnFlip — your agent for code and daily tasks is running");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open OnFlip", click: showWindow },
      { label: "New window", click: () => void createWindow() },
      { type: "separator" },
      {
        label: "Quit OnFlip",
        click: () => {
          app.quit();
        },
      },
    ])
  );
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

// ---------------------------------------------------------------------------
// IPC surface for the renderers
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("engine-call", async (e, payload: { method: string; params?: unknown }) => {
    const ws = wsOf(e);
    if (!ws?.peer || ws.engineExited) throw new Error("The engine is not running.");
    // A fresh renderer — first load or a reload — announces itself with init.
    if (payload.method === "init") resendApprovals(ws);
    return await ws.peer.request(payload.method, payload.params ?? {});
  });

  ipcMain.on("approval-response", (_e, payload: { id: number; decision: ApprovalDecisionDTO }) => {
    // Answered in the app: close the phone's copy so nobody is left holding
    // live buttons for a settled question.
    if (approvalWaiters.has(payload.id)) {
      telegramApprovalDone(payload.id, payload.decision.allow ? "allowed here" : "denied here");
    }
    const waiter = approvalWaiters.get(payload.id);
    setImmediate(refreshIndicator);
    if (!waiter) return;
    approvalWaiters.delete(payload.id);
    waiter.resolve(payload.decision);
  });

  // Another window, another engine, another concurrent session.
  // The panel owns the layout, so it measures its own placeholder and sends
  // the rectangle; a native view knows nothing about CSS and would otherwise
  // have to be positioned by guessing at the app's geometry.
  ipcMain.handle(
    "browser-view-bounds",
    (e, payload: { x: number; y: number; width: number; height: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return false;
      return setViewBounds(win, payload);
    }
  );

  // Closing the panel must not throw the page away — the agent may still be
  // working in it — so this only takes it off screen.
  ipcMain.handle("browser-view-hide", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) hideView(win);
    return true;
  });

  // The renderer decides whether to draw a placeholder or the old screencast,
  // and it cannot know which until it is told whether the port opened.
  ipcMain.handle("browser-view-available", () => resolveEndpoint() !== null);

  ipcMain.handle("browser-view-chrome", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? viewChrome(win) : null;
  });
  ipcMain.handle("browser-view-act", (e, payload: { action: ViewAction }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? actOnView(win, payload.action) : false;
  });
  /**
   * Hand the page to the user's own browser.
   *
   * Its own handler rather than reusing `open-release`, which is locked to
   * this project's release pages on purpose: `openExternal` will launch
   * anything at all, a `file://` path included. Http and https only, and
   * only what the view is actually showing.
   */
  ipcMain.handle("browser-view-external", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const showing = win ? (viewChrome(win)?.url ?? "") : "";
    // A refusal page is not worth opening anywhere: see `externalTarget`.
    const url = externalTarget(showing);
    if (!/^https?:\/\//i.test(url)) return false;
    void shell.openExternal(url);
    return true;
  });

  ipcMain.handle("browser-view-go", (e, payload: { url: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? navigateView(win, payload.url) : false;
  });

  /**
   * The floor the window cannot be dragged below.
   *
   * A fixed one cannot work: the sidebar and the two side panels are all
   * resizable, and at their own minimums they already add up to more than
   * the window's old 760px floor — leaving the chat column exactly nothing.
   * The renderer knows what is open and how wide it is, so it does the
   * arithmetic and the window follows.
   */
  ipcMain.handle("set-min-width", (e, payload: { width: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    // Never wider than the display it is on: a minimum bigger than the
    // screen is a window that cannot be placed at all.
    const usable = screen.getDisplayMatching(win.getBounds()).workAreaSize.width;
    const width = Math.max(760, Math.min(Math.round(payload.width), usable));
    const [, minHeight] = win.getMinimumSize();
    win.setMinimumSize(width, minHeight);
    // Growing the floor past where the window already is has to widen it too,
    // or the constraint is one the user can see and not satisfy. Not while
    // maximised or full screen, though: the window is already as wide as it
    // can be, and setting bounds there drops it out of that state for no
    // gain the user asked for.
    if (!win.isMaximized() && !win.isFullScreen()) {
      const bounds = win.getBounds();
      if (bounds.width < width) win.setBounds({ ...bounds, width });
    }
    return true;
  });

  // -- scheduled prompts ---------------------------------------------------
  ipcMain.handle("indicator-get", () => indicatorSettings());
  ipcMain.handle(
    "indicator-set",
    (_e, payload: { enabled?: boolean; size?: number }) => {
      const next = applyIndicator(payload);
      refreshIndicator();
      return next;
    }
  );

  ipcMain.handle("telegram-get", () => telegramPublic());
  ipcMain.handle(
    "telegram-save",
    (_e, payload: { enabled?: boolean; token?: string; allowedIds?: string }) =>
      saveTelegram(payload)
  );

  ipcMain.handle("schedules-list", () => listSchedules());
  ipcMain.handle(
    "schedule-create",
    (e, payload: { prompt: string; cron: string; cwd?: string }) => {
      const ws = wsOf(e);
      // The project the window is on, so a schedule made here runs here.
      const cwd = payload.cwd || currentCwd(ws) || process.cwd();
      return createSchedule({ prompt: payload.prompt, cron: payload.cron, cwd });
    }
  );
  ipcMain.handle(
    "schedule-update",
    (_e, payload: { id: string; prompt?: string; cron?: string; enabled?: boolean }) =>
      updateSchedule(payload.id, payload)
  );
  ipcMain.handle("schedule-delete", (_e, payload: { id: string }) =>
    deleteSchedule(payload.id)
  );
  ipcMain.handle("schedule-run", (_e, payload: { id: string }) => runScheduleNow(payload.id));

  ipcMain.handle("new-window", () => {
    createWindow();
    return true;
  });

  ipcMain.handle("pick-folder", async (e) => {
    const ws = wsOf(e);
    if (!ws) return null;
    const result = await dialog.showOpenDialog(ws.win, {
      title: "Open project folder",
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(
    "save-file",
    async (e, payload: { suggestedName: string; content: string }) => {
      const ws = wsOf(e);
      if (!ws) return null;
      const result = await dialog.showSaveDialog(ws.win, {
        title: "Export transcript",
        defaultPath: path.join(os.homedir(), payload.suggestedName),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, payload.content, "utf8");
      return result.filePath;
    }
  );

  // Attachments: the picker returns paths, and the engine hands them to the
  // ChatGPT composer. Nothing is copied — the file is uploaded from where it
  // already lives.
  ipcMain.handle("pick-files", async (e) => {
    const ws = wsOf(e);
    if (!ws) return [];
    const result = await dialog.showOpenDialog(ws.win, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images and documents",
          extensions: [
            "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
            "pdf", "txt", "md", "csv", "json", "docx", "xlsx", "pptx",
          ],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // Saving an image the model drew. It arrives as a data URL because it lived
  // on the ChatGPT page rather than on disk.
  ipcMain.handle(
    "save-image",
    async (e, payload: { dataUrl: string; suggestedName: string }) => {
      const ws = wsOf(e);
      if (!ws) return null;
      const match = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(payload.dataUrl ?? "");
      if (!match) return null;
      const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
      const result = await dialog.showSaveDialog(ws.win, {
        title: "Save image",
        defaultPath: path.join(
          app.getPath("downloads"),
          payload.suggestedName?.replace(/\.[a-z0-9]+$/i, "") || "chatgpt-image"
        ) + `.${ext}`,
        filters: [{ name: "Image", extensions: [ext] }],
      });
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, Buffer.from(match[2], "base64"));
      return result.filePath;
    }
  );

  // A file a folder-less chat produced, copied wherever the user points.
  // Copy, not move: the scratch workspace stays intact, so the chat can keep
  // editing the document it just delivered.
  ipcMain.handle(
    "save-artifact",
    async (e, payload: { path: string; suggestedName: string }) => {
      const ws = wsOf(e);
      if (!ws) return null;
      if (!payload?.path || !fs.existsSync(payload.path)) return null;
      const result = await dialog.showSaveDialog(ws.win, {
        title: "Save file",
        defaultPath: path.join(
          app.getPath("downloads"),
          payload.suggestedName || path.basename(payload.path)
        ),
      });
      if (result.canceled || !result.filePath) return null;
      fs.copyFileSync(payload.path, result.filePath);
      return result.filePath;
    }
  );

  ipcMain.handle("open-artifact", async (_e, payload: { path: string }) => {
    if (!payload?.path || !fs.existsSync(payload.path)) return false;
    const error = await shell.openPath(payload.path);
    return error === "";
  });

  // Show it where it lives rather than opening it. A chip in the transcript
  // names a file that was sent; the useful thing to do with it is find it
  // again, and opening an unknown file with its default application is a
  // bigger step than the click implies.
  ipcMain.handle("reveal-file", (_e, payload: { path: string }) => {
    if (!payload?.path || !fs.existsSync(payload.path)) return false;
    shell.showItemInFolder(path.resolve(payload.path));
    return true;
  });

  ipcMain.handle("restart-engine", async (e, payload: { cwd?: string }) => {
    const ws = wsOf(e);
    if (!ws) return false;
    await stopEngine(ws);
    startEngine(ws, payload?.cwd);
    return true;
  });

  ipcMain.handle("app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle("check-update", () => checkForUpdate());

  /**
   * Download the update and hand it to the installer.
   *
   * Returns as soon as the work is under way; progress arrives on
   * `update-progress`, because a download is the one thing here long enough
   * that a person needs to see it moving. `updating` guards against a second
   * click on a modal that is already working — the button is disabled too,
   * but the IPC is what actually has to hold.
   */
  ipcMain.handle("start-update", async (event) => {
    if (updating) return { started: false, reason: "already running" };
    const info = await checkForUpdate();
    if (!info.available || !info.installable) {
      // Nothing to install for this platform or architecture. The caller
      // falls back to the release page, which is what it did before.
      return { started: false, reason: "no installable build for this platform" };
    }
    updating = true;
    const web = event.sender;
    const report = (p: UpdateProgress) => {
      if (!web.isDestroyed()) web.send("update-progress", p);
    };
    void (async () => {
      try {
        console.log(`[desktop] downloading update ${info.latest}: ${info.installable!.name}`);
        const file = await downloadUpdate(info.installable!.url, info.installable!.name, report);
        console.log(`[desktop] update downloaded to ${file}; handing off to the installer`);
        report({ phase: "installing" });
        const { relaunches } = applyUpdate(file);
        if (!relaunches) {
          updating = false;
          report({ phase: "error", message: "This platform has no automatic installer." });
          return;
        }
        // Give the renderer a moment to paint "installing" before the window
        // goes: quitting instantly makes a successful update look like a
        // crash. The hand-off process is already detached and waiting.
        setTimeout(() => {
          quittingForUpdate = true;
          app.quit();
        }, 1_200);
      } catch (e) {
        updating = false;
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[desktop] update failed: ${message}`);
        report({ phase: "error", message });
      }
    })();
    return { started: true };
  });

  // The renderer decides when to offer an update; opening the page is the
  // one thing it cannot do for itself.
  ipcMain.handle("open-release", (_e, payload: { url: string }) => {
    const url = String(payload?.url ?? "");
    // Only ever our own releases. This url arrives from the renderer and
    // openExternal will launch anything at all, including a file:// path.
    const allowed = [
      "https://github.com/khudayarovich/onflip-agent/",
      "https://objects.githubusercontent.com/",
      "https://release-assets.githubusercontent.com/",
    ];
    if (!allowed.some((prefix) => url.startsWith(prefix))) return false;
    void shell.openExternal(url);
    return true;
  });

  // Keep native menus and dialogs in step with the renderer's theme.
  /**
   * Which service this run drives, and switching to another.
   *
   * A switch relaunches rather than reloads, and that is the honest shape of
   * it: a provider is a different browser profile, a different signed-in
   * account and a different set of chats, and the engine holds a live
   * conversation on one of them. Restarting is how all of that is let go of
   * cleanly, and it is what makes "your DeepSeek chats and your ChatGPT chats
   * are separate" true rather than merely intended.
   */
  ipcMain.handle("provider-get", () => ({
    id: activeProvider(),
    label: providerLabel(),
    all: PROVIDER_IDS.map((id) => ({ id, label: providerLabel(id) })),
  }));

  ipcMain.handle("provider-set", (_e, payload: { id?: string }) => {
    const id = payload?.id;
    if (!isProviderId(id)) return { ok: false, reason: "Unknown provider." };
    if (id === activeProvider()) return { ok: false, reason: "Already on that provider." };
    saveConfig({ provider: id });
    // Relaunch after this call has returned, so the renderer is not waiting on
    // a reply from a process that is exiting.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);
    return { ok: true, id };
  });

  ipcMain.handle("set-theme", (_e, payload: { theme: "dark" | "light" }) => {
    nativeTheme.themeSource = payload.theme;
    return true;
  });

  // Notification preference and interface language, which the main process
  // needs because the toasts are its own.
  ipcMain.handle("set-prefs", (_e, payload: { notifications?: boolean; language?: string }) => {
    const prefs: Partial<DesktopState> = {};
    if (typeof payload?.notifications === "boolean") prefs.notifications = payload.notifications;
    if (typeof payload?.language === "string") prefs.language = payload.language.slice(0, 8);
    if (Object.keys(prefs).length) saveState(prefs);
    return true;
  });

  // Window controls for the frameless titlebar. Close goes through the same
  // close path as the OS button, so the last window hides to the tray rather
  // than quitting.
  ipcMain.handle("win-control", (e, payload: { action: string }) => {
    const ws = wsOf(e);
    if (!ws) return { maximized: false };
    switch (payload.action) {
      case "minimize":
        ws.win.minimize();
        break;
      case "maximize":
        if (ws.win.isMaximized()) ws.win.unmaximize();
        else ws.win.maximize();
        break;
      case "close":
        ws.win.close();
        break;
    }
    return { maximized: ws.win.isDestroyed() ? false : ws.win.isMaximized() };
  });

  ipcMain.handle("sign-in", async (e) => {
    const ws = wsOf(e);
    const result = await runSignIn(ws?.win ?? null);
    if (result.ok && result.cookies?.length && ws?.peer) {
      try {
        await ws.peer.request("applySignIn", {
          cookies: result.cookies,
          account: result.account,
        });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: result.ok, reason: result.reason };
  });

  // Signing out clears the window's partition here and the stored session
  // plus the automation profile in the engine — all three, or the next send
  // simply signs back in.
  ipcMain.handle("sign-out", async (e) => {
    const ws = wsOf(e);
    await clearSignIn();
    if (ws?.peer) {
      try {
        await ws.peer.request("applySignOut", {});
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: true };
  });

  registerTerminal();
}

// ---------------------------------------------------------------------------
// built-in terminal
// ---------------------------------------------------------------------------

/**
 * A line-based command runner, not a full PTY: each command runs through
 * PowerShell with output streamed to the panel. That covers what a built-in
 * terminal is for — builds, tests, git — without a native pty dependency.
 * These are the user's own keystrokes, so no approval layer applies. One
 * running command per window, like one terminal panel per window.
 */

/** Marks the line carrying the working directory back out of PowerShell. */
const CWD_SENTINEL = "\x01ONFLIP_CWD:";

function registerTerminal(): void {
  ipcMain.handle("term-run", (e, payload: { command: string; cwd: string }) => {
    const ws = wsOf(e);
    if (!ws) return { ok: false, error: "No window." };
    if (ws.termChild) {
      return { ok: false, error: "A command is still running — stop it first." };
    }
    const { command, cwd } = payload;

    let child: ChildProcess;
    try {
      if (process.platform === "win32") {
        // -EncodedCommand sidesteps every quoting hazard in the user's
        // command. The prelude makes output land as UTF-8 whatever the
        // system codepage is — without it, Cyrillic (and any non-ASCII)
        // arrives in the OEM encoding and renders as mojibake. Progress
        // records are silenced because a redirected PowerShell serialises
        // them as CLIXML blobs on stderr; the command's real errors are
        // merged into stdout as plain text instead. The sentinel line rides
        // at the end so `cd` persists between commands.
        const script = [
          "$ProgressPreference = 'SilentlyContinue'",
          "try { $null = chcp 65001 } catch {}",
          "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
          "try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
          "& {",
          command,
          "} 2>&1 | Out-String -Stream",
          'Write-Output ([char]1 + "ONFLIP_CWD:" + (Get-Location).Path)',
        ].join("\n");
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        child = spawn(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
        );
      } else {
        // macOS/Linux: a login bash, detached into its own process group so
        // stopping a command can take its whole tree down. Same sentinel.
        const script = `{ ${command}\n} 2>&1; printf '\\n\\001ONFLIP_CWD:%s\\n' "$PWD"`;
        child = spawn("/bin/bash", ["-lc", script], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    ws.termChild = child;

    let finalCwd = cwd;
    let pendingOut = "";
    const forwardOut = (chunk: Buffer) => {
      pendingOut += chunk.toString();
      const lines = pendingOut.split(/\r?\n/);
      pendingOut = lines.pop() ?? "";
      const visible: string[] = [];
      for (const line of lines) {
        const at = line.indexOf(CWD_SENTINEL);
        if (at >= 0) {
          finalCwd = line.slice(at + CWD_SENTINEL.length).trim() || finalCwd;
          continue;
        }
        visible.push(line);
      }
      if (visible.length) {
        sendTo(ws, "term-data", { kind: "out", text: `${visible.join("\n")}\n` });
      }
    };
    child.stdout?.on("data", forwardOut);
    // Real errors arrive merged into stdout; what reaches stderr is mostly
    // PowerShell's CLIXML wrapper, which is noise — strip it, forward the rest.
    let errPending = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      let text = errPending + chunk.toString();
      errPending = "";
      text = text.replace(/#< CLIXML\r?\n?/g, "");
      if (text.includes("<Objs") && !text.includes("</Objs>")) {
        errPending = text; // an unfinished blob — wait for the rest
        return;
      }
      text = text.replace(/<Objs[\s\S]*?<\/Objs>\r?\n?/g, "");
      if (text.trim()) sendTo(ws, "term-data", { kind: "err", text });
    });
    child.on("close", (code) => {
      if (pendingOut.trim() && !pendingOut.includes(CWD_SENTINEL)) {
        sendTo(ws, "term-data", { kind: "out", text: `${pendingOut}\n` });
      }
      ws.termChild = null;
      sendTo(ws, "term-exit", { code: code ?? 0, cwd: finalCwd });
    });
    child.on("error", (err) => {
      ws.termChild = null;
      sendTo(ws, "term-data", { kind: "err", text: `${err.message}\n` });
      sendTo(ws, "term-exit", { code: -1, cwd: finalCwd });
    });
    return { ok: true };
  });

  ipcMain.handle("term-kill", (e) => {
    const ws = wsOf(e);
    const child = ws?.termChild;
    if (!child?.pid) return false;
    killTree(child);
    return true;
  });

  app.on("before-quit", () => {
    for (const ws of workspaces.values()) {
      if (ws.termChild) killTree(ws.termChild);
    }
  });
}

/** Stop a terminal command and everything it started. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // /T takes the whole tree down — the shell plus whatever it started.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      // Detached spawn made the child a group leader; signal the group.
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

// The dev checkout and the installed app must not share an identity: the
// single-instance lock lives in userData, so a running `npm start` would make
// the installed OnFlip.exe quit silently on launch — which reads as "the app
// does nothing". Packaged builds keep the real directory; dev gets its own.
if (!app.isPackaged) {
  const devData = `${app.getPath("userData")}-dev`;
  try {
    // Carry the shell state (last project, window bounds) across the split.
    const legacy = path.join(app.getPath("userData"), "desktop-state.json");
    const moved = path.join(devData, "desktop-state.json");
    if (fs.existsSync(legacy) && !fs.existsSync(moved)) {
      fs.mkdirSync(devData, { recursive: true });
      fs.copyFileSync(legacy, moved);
    }
  } catch {
    /* cosmetic */
  }
  app.setPath("userData", devData);
}

// Before anything else touches Chromium: a command-line switch appended
// after it has initialised is ignored, and this one is what lets the
// agent's browser be a real view inside the window.
enableEmbeddedBrowser();

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  // Launching the app again — from the Start Menu, or the installer's
  // shortcut — surfaces the running instance, including out of the tray.
  app.on("second-instance", () => {
    showWindow();
  });

  // Windows shows toasts only for an app with an AppUserModelID; the
  // installer gives the shortcut this one, and a dev checkout needs it set.
  if (process.platform === "win32") app.setAppUserModelId("com.onflip.desktop");

  // Every web-facing window, popups included, introduces itself as Chrome.
  // Registered before the app is ready so no window can be created ahead of
  // it — a sign-in popup that slips through is exactly the case this exists
  // for.
  guardWebContents();

  void app.whenReady().then(() => {
    // No menu bar on Windows and Linux: the window draws its own chrome, and
    // the default menu's accelerators still fired underneath it — Ctrl+R
    // reloaded the renderer mid-turn and orphaned whatever prompt was up.
    // macOS keeps the default menu, which is where Copy and Paste live; a
    // dev checkout keeps it everywhere for the DevTools shortcut.
    if (process.platform !== "darwin" && app.isPackaged) Menu.setApplicationMenu(null);

    // Scheduled prompts. Armed here rather than at module load so the first
    // tick cannot land before there is a window and an engine to send into.
    startScheduler(fireSchedule, () => {
      for (const ws of workspaces.values()) {
        if (!ws.win.isDestroyed()) sendTo(ws, "schedules-changed", {});
      }
    });

    // The Telegram remote. It drives whichever window is in front, through
    // the same engine RPC the window itself uses — there is one OnFlip and
    // two ways to reach it.
    startIndicator();

    startTelegram({
      status: () => {
        const ws = telegramTarget();
        return { ...(ws?.lastStatus ?? {}), cwd: ws?.cwd };
      },
      call: async (method, params) => {
        const ws = telegramTarget();
        if (!ws?.peer || ws.engineExited) throw new Error("OnFlip is not running.");
        telegramWs = ws;
        return (await ws.peer.request(method, params ?? {})) as never;
      },
      changed: () => {
        for (const ws of workspaces.values()) {
          if (!ws.win.isDestroyed()) sendTo(ws, "telegram-changed", {});
        }
      },
      answerApproval: (id, decision) => {
        const waiter = approvalWaiters.get(id);
        if (!waiter) return false;
        approvalWaiters.delete(id);
        waiter.resolve(decision);
        // The app's own dialog is still on screen for this one; telling the
        // renderer closes it rather than leaving a prompt nobody can answer.
        sendTo(waiter.ws, "approval-settled", { id });
        return true;
      },
    });
    registerIpc();
    createWindow();
    // The tray icon is a Windows .ico; macOS keeps the app in the dock
    // instead, which is that platform's own version of background mode.
    if (process.platform === "win32") createTray();

    // Look for a new version on a timer rather than only at launch. A tray
    // app can stay open for days, and the version that fixed something for
    // someone is no use sitting in a release they will not visit. The banner
    // goes to whichever window is in front; if none is, the next check finds
    // the same version and offers it again.
    startUpdateWatch((info) => {
      // Logged because an update that never appears is otherwise invisible:
      // there is no error to report, and the person only knows they are on
      // an old version.
      console.log(
        `[desktop] update available: ${info.latest} (running ${info.current}), ` +
          `installable: ${info.installable ? info.installable.name : "no"}`
      );
      const ws = frontWorkspace();
      if (ws) sendTo(ws, "update-available", info);
      else console.log("[desktop] no window to show the update banner; will offer again later");
    });
  });

  // A tray app outlives its windows: all-closed just means "in the background".
  app.on("window-all-closed", () => {});

  // macOS: clicking the dock icon brings the hidden window back.
  app.on("activate", () => {
    showWindow();
  });

  let enginesStopped = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (enginesStopped) return;
    // Give every engine a clean shutdown (session save, browser close) first.
    e.preventDefault();
    void Promise.all([...workspaces.values()].map((ws) => stopEngine(ws))).then(() => {
      enginesStopped = true;
      tray?.destroy();
      app.quit();
    });
  });
}
