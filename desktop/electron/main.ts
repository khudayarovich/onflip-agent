import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
  Tray,
  Menu,
} from "electron";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Peer } from "../shared/wire";
import { runSignIn, clearSignIn } from "./signin";
import type { ApprovalDecisionDTO, EngineStatus } from "../shared/protocol";

/**
 * The Electron main process is deliberately thin: it owns the window and the
 * engine child, and relays messages between the renderer and the engine. All
 * agent behaviour lives in the engine, which runs the OnFlip core under plain
 * Node — the same runtime the CLI uses, so everything behaves identically.
 */

let win: BrowserWindow | null = null;
let engine: ChildProcess | null = null;
let peer: Peer | null = null;
let engineExited = false;
let tray: Tray | null = null;
/** Set once the user chose Quit; before that, closing the window hides it. */
let quitting = false;

function appIcon(): string {
  return path.join(__dirname, "..", "..", "buildResources", "icon.ico");
}

// ---------------------------------------------------------------------------
// small persistent state of the shell itself (not the agent)
// ---------------------------------------------------------------------------

interface DesktopState {
  lastCwd?: string;
  bounds?: { x?: number; y?: number; width: number; height: number };
}

function stateFile(): string {
  return path.join(app.getPath("userData"), "desktop-state.json");
}

function loadState(): DesktopState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as DesktopState;
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
  try {
    const child = spawn(nodeBin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Everything the engine prints to stderr, kept on disk.
 *
 * It used to go only to the renderer's debug panel, which is how an engine
 * death took its evidence with it: the process vanished mid-turn with nothing
 * in any log, because the one channel that carries a native crash or an
 * out-of-memory abort — stderr — was never persisted. JS-level failures are
 * caught and survive; the ones that kill a process outright only ever say why
 * here.
 */
function engineStderrLog(): fs.WriteStream | null {
  try {
    const file = path.join(app.getPath("userData"), "engine-stderr.log");
    // Fresh engine, bounded file: keep the previous run's tail, not a year's.
    try {
      if (fs.statSync(file).size > 1_000_000) fs.rmSync(file, { force: true });
    } catch {
      /* first run */
    }
    const stream = fs.createWriteStream(file, { flags: "a" });
    stream.write(`\n--- engine started ${new Date().toISOString()} ---\n`);
    return stream;
  } catch {
    return null;
  }
}

function startEngine(cwd: string): void {
  engineExited = false;
  let child = spawnEngine(cwd);
  const stderrLog = engineStderrLog();

  const wire = new Peer((chunk) => {
    child.stdin?.write(chunk);
  });
  peer = wire;

  const attach = (c: ChildProcess) => {
    c.stdout?.on("data", (chunk: Buffer) => wire.feed(chunk));
    c.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderrLog?.write(chunk);
      } catch {
        /* the copy on disk is best-effort */
      }
      sendToRenderer("engine-event", { event: "log", data: { line: chunk.toString("utf8") } });
    });
    c.on("error", (e: NodeJS.ErrnoException) => {
      // No system Node — retry once inside Electron's own Node.
      if (e.code === "ENOENT" && c === child) {
        const fallback = spawnEngineViaElectron([engineEntry(), "--cwd", cwd], cwd);
        child = fallback;
        engine = fallback;
        attach(fallback);
        return;
      }
      sendToRenderer("engine-event", {
        event: "connect",
        data: { state: "error", detail: `Engine failed to start: ${e.message}` },
      });
    });
    c.on("exit", (code) => {
      if (c !== child) return;
      engineExited = true;
      try {
        stderrLog?.write(`--- engine exited ${new Date().toISOString()} code ${code ?? "unknown"} ---\n`);
        stderrLog?.end();
      } catch {
        /* best-effort */
      }
      wire.failAll(`The engine exited (code ${code ?? "unknown"}).`);
      sendToRenderer("engine-exit", { code });
    });
  };
  attach(child);
  engine = child;

  wire.onEvent = (event, data) => {
    if (event === "status") {
      const status = data as EngineStatus;
      if (status.cwd) saveState({ lastCwd: status.cwd });
    }
    sendToRenderer("engine-event", { event, data });
  };

  // The engine's own requests — approvals — go to the renderer and wait there.
  wire.onRequest = async (method, params) => {
    if (method === "approval") {
      return await askRendererForApproval(params);
    }
    throw new Error(`Unknown engine->app request: ${method}`);
  };

  wire.onNoise = (line) => {
    sendToRenderer("engine-event", { event: "log", data: { line } });
  };
}

// Pending approval prompts, answered by the renderer.
let nextApprovalId = 1;
const approvalWaiters = new Map<number, (d: ApprovalDecisionDTO) => void>();

function askRendererForApproval(request: unknown): Promise<ApprovalDecisionDTO> {
  const id = nextApprovalId++;
  return new Promise<ApprovalDecisionDTO>((resolve) => {
    approvalWaiters.set(id, resolve);
    sendToRenderer("approval-request", { id, request });
    win?.show();
    win?.focus();
  });
}

async function stopEngine(): Promise<void> {
  const child = engine;
  if (!child) return;
  engine = null;
  const wire = peer;
  peer = null;
  wire?.failAll("The engine is restarting.");
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
// window
// ---------------------------------------------------------------------------

function createWindow(): void {
  const state = loadState();
  nativeTheme.themeSource = "dark";

  win = new BrowserWindow({
    width: state.bounds?.width ?? 1280,
    height: state.bounds?.height ?? 840,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 760,
    minHeight: 520,
    show: false,
    icon: path.join(__dirname, "..", "..", "buildResources", "icon.ico"),
    backgroundColor: "#0d0d0d",
    // Fully frameless: the renderer draws its own minimise/maximise/close so
    // they match the app instead of the OS defaults.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  // The custom maximise button swaps its glyph with the real window state.
  win.on("maximize", () => win?.webContents.send("win-state", { maximized: true }));
  win.on("unmaximize", () => win?.webContents.send("win-state", { maximized: false }));
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
  if (shot) {
    win.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        void win?.webContents.capturePage().then((image) => {
          fs.writeFileSync(shot, image.toPNG());
          process.stdout.write(`[shot] ${shot}\n`);
        });
      }, 9_000);
    });
  }
  // Closing the window keeps OnFlip alive in the tray — the engine (and any
  // running turn) carries on in the background, the way Codex does it.
  win.on("close", (e) => {
    if (!win) return;
    saveState({ bounds: win.getBounds() });
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // External links open in the user's real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(path.join(__dirname, "..", "..", "ui-dist", "index.html"));
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): void {
  tray = new Tray(appIcon());
  tray.setToolTip("OnFlip — your coding agent is running");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open OnFlip", click: showWindow },
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
// IPC surface for the renderer
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("engine-call", async (_e, payload: { method: string; params?: unknown }) => {
    if (!peer || engineExited) throw new Error("The engine is not running.");
    return await peer.request(payload.method, payload.params ?? {});
  });

  ipcMain.on("approval-response", (_e, payload: { id: number; decision: ApprovalDecisionDTO }) => {
    const waiter = approvalWaiters.get(payload.id);
    if (!waiter) return;
    approvalWaiters.delete(payload.id);
    waiter(payload.decision);
  });

  ipcMain.handle("pick-folder", async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Open project folder",
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(
    "save-file",
    async (_e, payload: { suggestedName: string; content: string }) => {
      if (!win) return null;
      const result = await dialog.showSaveDialog(win, {
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
  ipcMain.handle("pick-files", async () => {
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
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
    async (_e, payload: { dataUrl: string; suggestedName: string }) => {
      if (!win) return null;
      const match = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(payload.dataUrl ?? "");
      if (!match) return null;
      const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
      const result = await dialog.showSaveDialog(win, {
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
    async (_e, payload: { path: string; suggestedName: string }) => {
      if (!win) return null;
      if (!payload?.path || !fs.existsSync(payload.path)) return null;
      const result = await dialog.showSaveDialog(win, {
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

  ipcMain.handle("restart-engine", async (_e, payload: { cwd?: string }) => {
    const cwd = payload?.cwd || loadState().lastCwd || os.homedir();
    await stopEngine();
    startEngine(cwd);
    return true;
  });

  ipcMain.handle("app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  // Keep native menus and dialogs in step with the renderer's theme.
  ipcMain.handle("set-theme", (_e, payload: { theme: "dark" | "light" }) => {
    nativeTheme.themeSource = payload.theme;
    return true;
  });

  // Window controls for the frameless titlebar. Close goes through the same
  // close path as the OS button, so it hides to the tray rather than quitting.
  ipcMain.handle("win-control", (_e, payload: { action: string }) => {
    if (!win) return { maximized: false };
    switch (payload.action) {
      case "minimize":
        win.minimize();
        break;
      case "maximize":
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
      case "close":
        win.close();
        break;
    }
    return { maximized: win.isMaximized() };
  });

  // Signing in happens in a normal browser window owned by the app (see
  // signin.ts), never in the automation browser: the cookies it collects go
  // straight to the engine, so they never pass through the renderer.
  ipcMain.handle("sign-in", async () => {
    const result = await runSignIn(win);
    if (result.ok && result.cookies?.length && peer) {
      try {
        await peer.request("applySignIn", {
          cookies: result.cookies,
          account: result.account,
        });
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    }
    return { ok: result.ok, reason: result.reason };
  });

  // Signing out clears the window's partition here and the stored session
  // plus the automation profile in the engine — all three, or the next send
  // simply signs back in.
  ipcMain.handle("sign-out", async () => {
    await clearSignIn();
    if (peer) {
      try {
        await peer.request("applySignOut", {});
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
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
 * These are the user's own keystrokes, so no approval layer applies.
 */
let termChild: ChildProcess | null = null;

/** Marks the line carrying the working directory back out of PowerShell. */
const CWD_SENTINEL = "\x01ONFLIP_CWD:";

function registerTerminal(): void {
  ipcMain.handle("term-run", (_e, payload: { command: string; cwd: string }) => {
    if (termChild) {
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
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    termChild = child;

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
        win?.webContents.send("term-data", { kind: "out", text: `${visible.join("\n")}\n` });
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
      if (text.trim()) win?.webContents.send("term-data", { kind: "err", text });
    });
    child.on("close", (code) => {
      if (pendingOut.trim() && !pendingOut.includes(CWD_SENTINEL)) {
        win?.webContents.send("term-data", { kind: "out", text: `${pendingOut}\n` });
      }
      termChild = null;
      win?.webContents.send("term-exit", { code: code ?? 0, cwd: finalCwd });
    });
    child.on("error", (e) => {
      termChild = null;
      win?.webContents.send("term-data", { kind: "err", text: `${e.message}\n` });
      win?.webContents.send("term-exit", { code: -1, cwd: finalCwd });
    });
    return { ok: true };
  });

  ipcMain.handle("term-kill", () => {
    const child = termChild;
    if (!child?.pid) return false;
    killTree(child);
    return true;
  });

  app.on("before-quit", () => {
    if (termChild) killTree(termChild);
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

  void app.whenReady().then(() => {
    registerIpc();
    createWindow();
    // The tray icon is a Windows .ico; macOS keeps the app in the dock
    // instead, which is that platform's own version of background mode.
    if (process.platform === "win32") createTray();
    startEngine(loadState().lastCwd || os.homedir());
  });

  // A tray app outlives its window: all-closed just means "in the background".
  app.on("window-all-closed", () => {});

  // macOS: clicking the dock icon brings the hidden window back.
  app.on("activate", () => {
    showWindow();
  });

  let engineStopped = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (engineStopped) return;
    // Give the engine a clean shutdown (session save, browser close) first.
    e.preventDefault();
    void stopEngine().then(() => {
      engineStopped = true;
      tray?.destroy();
      app.quit();
    });
  });
}
