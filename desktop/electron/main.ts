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
import { Peer } from "../shared/wire";
import { runSignIn, clearSignIn } from "./signin";
import { checkForUpdate } from "./updates";
import {
  applyUpdate,
  downloadUpdate,
  startUpdateWatch,
  type UpdateProgress,
} from "./update-install";
import { pairWithBrowser, extensionDir } from "./pairing";
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
  const env = { ...process.env, ONFLIP_ELECTRON_PATH: process.execPath };
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
      if (status.cwd) saveState({ lastCwd: status.cwd });
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
      } else if (turn.state === "end" && !turn.interrupted) {
        if (turn.exhausted) notifyAway(ws, "exhausted", turn.error ?? "");
        else if (turn.error) notifyAway(ws, "error", turn.error);
        else if (ws.lastFinal?.kind !== "question") notifyAway(ws, "finished", ws.lastFinal?.text ?? "");
      }
    }
    sendTo(ws, "engine-event", { event, data });
  };

  // The engine's own requests — approvals — go to this window and wait there.
  wire.onRequest = async (method, params) => {
    if (method === "approval") {
      return await askRendererForApproval(ws, params);
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
    const waiter = approvalWaiters.get(payload.id);
    if (!waiter) return;
    approvalWaiters.delete(payload.id);
    waiter.resolve(payload.decision);
  });

  // Another window, another engine, another concurrent session.
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
        const file = await downloadUpdate(info.installable!.url, info.installable!.name, report);
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
        report({
          phase: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return { started: true };
  });

  // Load unpacked wants a folder, so the app has to be able to say which
  // one and put it in front of the user. Shipped in resources, because
  // nobody who ran the installer has a checkout to point at.
  ipcMain.handle("extension-info", () => {
    const dir = extensionDir();
    return { dir, present: fs.existsSync(path.join(dir, "manifest.json")) };
  });

  ipcMain.handle("open-extension-folder", async () => {
    const dir = extensionDir();
    if (!fs.existsSync(dir)) return false;
    await shell.openPath(dir);
    return true;
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

  // Signing in happens in a normal browser window owned by the app (see
  // signin.ts), never in the automation browser: the cookies it collects go
  // straight to the engine, so they never pass through the renderer. The
  // session lands in ~/.onflip, so other windows' engines pick it up when
  // they next need it.
  // The browser the user actually uses, asked rather than read. Runs the
  // loopback handshake in `pairing.ts` and applies whatever comes back
  // through the same path as every other sign-in.
  ipcMain.handle("pair-browser", async (e) => {
    const ws = wsOf(e);
    const result = await pairWithBrowser();
    if (result.ok && result.cookies?.length && ws?.peer) {
      try {
        await ws.peer.request("applySignIn", { cookies: result.cookies });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: result.ok, reason: result.reason };
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

  void app.whenReady().then(() => {
    // No menu bar on Windows and Linux: the window draws its own chrome, and
    // the default menu's accelerators still fired underneath it — Ctrl+R
    // reloaded the renderer mid-turn and orphaned whatever prompt was up.
    // macOS keeps the default menu, which is where Copy and Paste live; a
    // dev checkout keeps it everywhere for the DevTools shortcut.
    if (process.platform !== "darwin" && app.isPackaged) Menu.setApplicationMenu(null);
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
      const ws = frontWorkspace();
      if (ws) sendTo(ws, "update-available", info);
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
