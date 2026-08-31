/** The preload bridge, as the renderer sees it. Mirrors electron/preload.ts. */
interface OnFlipBridge {
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
  setTheme(theme: "dark" | "light"): Promise<boolean>;
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
