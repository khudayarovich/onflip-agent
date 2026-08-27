/** The preload bridge, as the renderer sees it. Mirrors electron/preload.ts. */
interface OnFlipBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  onApproval(listener: (id: number, request: unknown) => void): () => void;
  respondApproval(id: number, decision: unknown): void;
  onEngineExit(listener: (code: number | null) => void): () => void;
  pickFolder(): Promise<string | null>;
  saveFile(suggestedName: string, content: string): Promise<string | null>;
  restartEngine(cwd?: string): Promise<boolean>;
  appInfo(): Promise<{ version: string; platform: string }>;
  setTheme(theme: "dark" | "light"): Promise<boolean>;
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
