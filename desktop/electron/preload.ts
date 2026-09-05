import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge between the sandboxed renderer and the rest of the app.
 * Everything is funnelled through a handful of channels; the renderer never
 * sees Node, Electron, or the engine process directly.
 */
export interface OnFlipBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  onApproval(listener: (id: number, request: unknown) => void): () => void;
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
  setTheme(theme: "dark" | "light"): Promise<boolean>;
  setPrefs(prefs: { notifications?: boolean; language?: string }): Promise<boolean>;
  signIn(): Promise<{ ok: boolean; reason?: string }>;
  pairBrowser(): Promise<{ ok: boolean; reason?: string }>;
  extensionInfo(): Promise<{ dir: string; present: boolean }>;
  openExtensionFolder(): Promise<boolean>;
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

  setTheme: (theme) => ipcRenderer.invoke("set-theme", { theme }),
  setPrefs: (prefs) => ipcRenderer.invoke("set-prefs", prefs),
  signIn: () => ipcRenderer.invoke("sign-in"),
  pairBrowser: () => ipcRenderer.invoke("pair-browser"),
  extensionInfo: () => ipcRenderer.invoke("extension-info"),
  openExtensionFolder: () => ipcRenderer.invoke("open-extension-folder"),
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
