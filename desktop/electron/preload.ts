import { contextBridge, ipcRenderer } from "electron";
import type { ScheduleDTO } from "../shared/protocol";

/**
 * The only bridge between the sandboxed renderer and the rest of the app.
 * Everything is funnelled through a handful of channels; the renderer never
 * sees Node, Electron, or the engine process directly.
 */
export interface OnFlipBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  onApproval(listener: (id: number, request: unknown) => void): () => void;
  /** The prompt was answered somewhere else — from Telegram, or another window. */
  onApprovalSettled(listener: (id: number) => void): () => void;
  respondApproval(id: number, decision: unknown): void;
  onEngineExit(listener: (code: number | null) => void): () => void;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  saveImage(dataUrl: string, suggestedName: string): Promise<string | null>;
  saveFile(suggestedName: string, content: string): Promise<string | null>;
  saveArtifact(path: string, suggestedName: string): Promise<string | null>;
  openArtifact(path: string): Promise<boolean>;
  newWindow(): Promise<boolean>;
  restartEngine(cwd?: string): Promise<boolean>;
  appInfo(): Promise<{ version: string; platform: string }>;
  checkUpdate(): Promise<{
    current: string;
    latest?: string;
    url: string;
    available: boolean;
    error?: string;
  }>;
  openRelease(url: string): Promise<boolean>;
  /** Download and install the update; progress arrives on onUpdateProgress. */
  startUpdate(): Promise<{ started: boolean; reason?: string }>;
  onUpdateProgress(
    listener: (p: {
      phase: "downloading" | "installing" | "error";
      percent?: number;
      receivedBytes?: number;
      totalBytes?: number;
      message?: string;
    }) => void
  ): () => void;
  /** The periodic check found a newer version. */
  onUpdateAvailable(
    listener: (info: { current: string; latest?: string; url: string; available: boolean }) => void
  ): () => void;
  /**
   * The agent's browser is a real view docked into the window, so the panel
   * tells the main process where it is instead of drawing anything itself.
   */
  browserViewBounds(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<boolean>;
  browserViewHide(): Promise<boolean>;
  /** The embedded browser's toolbar: where it is, and moving it. */
  browserViewChrome(): Promise<{
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  } | null>;
  browserViewAct(action: "back" | "forward" | "reload" | "stop"): Promise<boolean>;
  browserViewGo(url: string): Promise<boolean>;
  /** Open whatever the view is showing in the user's own browser. */
  browserViewExternal(): Promise<boolean>;
  onBrowserChrome(listener: (chrome: unknown) => void): () => void;

  /** The narrowest this window may be dragged, given what is open. */
  setMinWidth(width: number): Promise<boolean>;
  /** False when the DevTools port never opened and the old screencast is in use. */
  browserViewAvailable(): Promise<boolean>;
  /**
   * Prompts that send themselves on a cron schedule. They live in the main
   * process, which is what outlives any one window.
   */
  schedulesList(): Promise<ScheduleDTO[]>;
  scheduleCreate(input: {
    prompt: string;
    cron: string;
    cwd?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  scheduleUpdate(input: {
    id: string;
    prompt?: string;
    cron?: string;
    enabled?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  scheduleDelete(id: string): Promise<boolean>;
  scheduleRun(id: string): Promise<{ status: string; detail?: string }>;
  onSchedulesChanged(listener: () => void): () => void;
  /** The Telegram remote: its state, and the fields that configure it. */
  /** The floating status square: what OnFlip is doing, at a glance. */
  indicatorGet(): Promise<{ enabled: boolean; size: number }>;
  indicatorSet(patch: { enabled?: boolean; size?: number }): Promise<{ enabled: boolean; size: number }>;
  telegramGet(): Promise<{
    enabled: boolean;
    hasToken: boolean;
    allowedIds: string;
    state: "off" | "connecting" | "connected" | "error";
    detail?: string;
    username?: string;
  }>;
  telegramSave(patch: {
    enabled?: boolean;
    token?: string;
    allowedIds?: string;
  }): Promise<{
    enabled: boolean;
    hasToken: boolean;
    allowedIds: string;
    state: "off" | "connecting" | "connected" | "error";
    detail?: string;
    username?: string;
  }>;
  onTelegramChanged(listener: () => void): () => void;
  setTheme(theme: "dark" | "light"): Promise<boolean>;
  setPrefs(prefs: { notifications?: boolean; language?: string }): Promise<boolean>;
  signIn(): Promise<{ ok: boolean; reason?: string }>;
  signOut(): Promise<{ ok: boolean; reason?: string }>;
  winControl(action: "minimize" | "maximize" | "close" | "query"): Promise<{ maximized: boolean }>;
  onWinState(listener: (state: { maximized: boolean }) => void): () => void;
  termRun(command: string, cwd: string): Promise<{ ok: boolean; error?: string }>;
  termKill(): Promise<boolean>;
  onTermData(listener: (data: { kind: "out" | "err"; text: string }) => void): () => void;
  onTermExit(listener: (data: { code: number; cwd: string }) => void): () => void;
}

const bridge: OnFlipBridge = {
  call: (method, params) => ipcRenderer.invoke("engine-call", { method, params }),

  onEvent: (listener) => {
    const handler = (_e: unknown, payload: { event: string; data: unknown }) =>
      listener(payload.event, payload.data);
    ipcRenderer.on("engine-event", handler);
    return () => ipcRenderer.removeListener("engine-event", handler);
  },

  onApproval: (listener) => {
    const handler = (_e: unknown, payload: { id: number; request: unknown }) =>
      listener(payload.id, payload.request);
    ipcRenderer.on("approval-request", handler);
    return () => ipcRenderer.removeListener("approval-request", handler);
  },
  onApprovalSettled: (listener) => {
    const handler = (_e: unknown, payload: { id: number }) => listener(payload.id);
    ipcRenderer.on("approval-settled", handler);
    return () => ipcRenderer.removeListener("approval-settled", handler);
  },

  respondApproval: (id, decision) => {
    ipcRenderer.send("approval-response", { id, decision });
  },

  onEngineExit: (listener) => {
    const handler = (_e: unknown, payload: { code: number | null }) => listener(payload.code);
    ipcRenderer.on("engine-exit", handler);
    return () => ipcRenderer.removeListener("engine-exit", handler);
  },

  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  saveImage: (dataUrl, suggestedName) =>
    ipcRenderer.invoke("save-image", { dataUrl, suggestedName }),
  saveFile: (suggestedName, content) =>
    ipcRenderer.invoke("save-file", { suggestedName, content }),
  saveArtifact: (path, suggestedName) =>
    ipcRenderer.invoke("save-artifact", { path, suggestedName }),
  openArtifact: (path) => ipcRenderer.invoke("open-artifact", { path }),
  newWindow: () => ipcRenderer.invoke("new-window"),
  restartEngine: (cwd) => ipcRenderer.invoke("restart-engine", { cwd }),
  appInfo: () => ipcRenderer.invoke("app-info"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  openRelease: (url) => ipcRenderer.invoke("open-release", { url }),

  browserViewBounds: (rect) => ipcRenderer.invoke("browser-view-bounds", rect),
  browserViewHide: () => ipcRenderer.invoke("browser-view-hide"),
  browserViewChrome: () => ipcRenderer.invoke("browser-view-chrome"),
  browserViewAct: (action) => ipcRenderer.invoke("browser-view-act", { action }),
  browserViewGo: (url) => ipcRenderer.invoke("browser-view-go", { url }),
  browserViewExternal: () => ipcRenderer.invoke("browser-view-external"),
  onBrowserChrome: (listener) => {
    const handler = (_e: unknown, chrome: unknown) => listener(chrome);
    ipcRenderer.on("browser-chrome", handler);
    return () => ipcRenderer.removeListener("browser-chrome", handler);
  },

  setMinWidth: (width) => ipcRenderer.invoke("set-min-width", { width }),
  browserViewAvailable: () => ipcRenderer.invoke("browser-view-available"),

  schedulesList: () => ipcRenderer.invoke("schedules-list"),
  scheduleCreate: (input) => ipcRenderer.invoke("schedule-create", input),
  scheduleUpdate: (input) => ipcRenderer.invoke("schedule-update", input),
  scheduleDelete: (id) => ipcRenderer.invoke("schedule-delete", { id }),
  scheduleRun: (id) => ipcRenderer.invoke("schedule-run", { id }),
  onSchedulesChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("schedules-changed", handler);
    return () => ipcRenderer.removeListener("schedules-changed", handler);
  },
  indicatorGet: () => ipcRenderer.invoke("indicator-get"),
  indicatorSet: (patch) => ipcRenderer.invoke("indicator-set", patch),
  telegramGet: () => ipcRenderer.invoke("telegram-get"),
  telegramSave: (patch) => ipcRenderer.invoke("telegram-save", patch),
  onTelegramChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("telegram-changed", handler);
    return () => ipcRenderer.removeListener("telegram-changed", handler);
  },
  setTheme: (theme) => ipcRenderer.invoke("set-theme", { theme }),
  setPrefs: (prefs) => ipcRenderer.invoke("set-prefs", prefs),
  signIn: () => ipcRenderer.invoke("sign-in"),
  signOut: () => ipcRenderer.invoke("sign-out"),
  winControl: (action) => ipcRenderer.invoke("win-control", { action }),
  startUpdate: () => ipcRenderer.invoke("start-update"),
  onUpdateProgress: (listener) => {
    const handler = (_e: unknown, p: Parameters<typeof listener>[0]) => listener(p);
    ipcRenderer.on("update-progress", handler);
    return () => ipcRenderer.removeListener("update-progress", handler);
  },
  onUpdateAvailable: (listener) => {
    const handler = (_e: unknown, info: Parameters<typeof listener>[0]) => listener(info);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },
  onWinState: (listener) => {
    const handler = (_e: unknown, state: { maximized: boolean }) => listener(state);
    ipcRenderer.on("win-state", handler);
    return () => ipcRenderer.removeListener("win-state", handler);
  },
  termRun: (command, cwd) => ipcRenderer.invoke("term-run", { command, cwd }),
  termKill: () => ipcRenderer.invoke("term-kill"),
  onTermData: (listener) => {
    const handler = (_e: unknown, data: { kind: "out" | "err"; text: string }) => listener(data);
    ipcRenderer.on("term-data", handler);
    return () => ipcRenderer.removeListener("term-data", handler);
  },
  onTermExit: (listener) => {
    const handler = (_e: unknown, data: { code: number; cwd: string }) => listener(data);
    ipcRenderer.on("term-exit", handler);
    return () => ipcRenderer.removeListener("term-exit", handler);
  },
};

contextBridge.exposeInMainWorld("onflip", bridge);
