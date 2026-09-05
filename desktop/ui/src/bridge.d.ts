/** The preload bridge, as the renderer sees it. Mirrors electron/preload.ts. */

interface OnFlipBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  onApproval(listener: (id: number, request: unknown) => void): () => void;
  /** The prompt was answered somewhere else — from Telegram, or another window. */
  onApprovalSettled?(listener: (id: number) => void): () => void;
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
  startUpdate?(): Promise<{ started: boolean; reason?: string }>;
  onUpdateProgress?(
    listener: (p: {
      phase: "downloading" | "installing" | "error";
      percent?: number;
      receivedBytes?: number;
      totalBytes?: number;
      message?: string;
    }) => void
  ): () => void;
  /** The main process's periodic check found a newer version. */
  onUpdateAvailable?(
    listener: (info: { current: string; latest?: string; url: string; available: boolean }) => void
  ): () => void;
  /**
   * The agent's browser is a real view docked into the window, so the panel
   * reports where it is rather than drawing anything itself. Optional because
   * an older preload will not have them — the panel then falls back to the
   * screencast it used to show.
   */
  browserViewBounds?(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<boolean>;
  browserViewHide?(): Promise<boolean>;
  /** The embedded browser's toolbar: where it is, and moving it. */
  browserViewChrome?(): Promise<{
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  } | null>;
  browserViewAct?(action: "back" | "forward" | "reload" | "stop"): Promise<boolean>;
  browserViewGo?(url: string): Promise<boolean>;
  /** Open whatever the view is showing in the user's own browser. */
  browserViewExternal?(): Promise<boolean>;
  onBrowserChrome?(listener: (chrome: unknown) => void): () => void;

  /** The narrowest this window may be dragged, given what is open. */
  setMinWidth?(width: number): Promise<boolean>;
  /** False when the DevTools port never opened and the screencast is in use. */
  browserViewAvailable?(): Promise<boolean>;
  /**
   * Prompts that send themselves on a cron schedule. They live in the main
   * process, which is what outlives any one window.
   */
  schedulesList?(): Promise<import("../../shared/protocol").ScheduleDTO[]>;
  scheduleCreate?(input: {
    prompt: string;
    cron: string;
    cwd?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  scheduleUpdate?(input: {
    id: string;
    prompt?: string;
    cron?: string;
    enabled?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  scheduleDelete?(id: string): Promise<boolean>;
  scheduleRun?(id: string): Promise<{ status: string; detail?: string }>;
  onSchedulesChanged?(listener: () => void): () => void;
  /** The Telegram remote: its state, and the fields that configure it. */
  telegramGet?(): Promise<{
    enabled: boolean;
    hasToken: boolean;
    allowedIds: string;
    state: "off" | "connecting" | "connected" | "error";
    detail?: string;
    username?: string;
  }>;
  telegramSave?(patch: {
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
  onTelegramChanged?(listener: () => void): () => void;
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

interface Window {
  onflip: OnFlipBridge;
}
