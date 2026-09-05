import type {
  ApprovalMode,
  ChatItem,
  ChatProjectDTO,
  ConfigView,
  EngineStatus,
  ExportResult,
  FileDiff,
  ModelDTO,
  RecentProjectDTO,
  RemoteChatDTO,
  RuleAction,
  SessionSummaryDTO,
  ThinkingLevel,
} from "../../shared/protocol";

/** Typed facade over the preload bridge. */
const call = <T>(method: string, params?: unknown): Promise<T> =>
  window.onflip.call(method, params) as Promise<T>;

export const api = {
  init: () => call<EngineStatus>("init"),
  status: () => call<EngineStatus>("status"),
  send: (text: string, attachments?: string[]) =>
    call<{ queued: boolean }>("send", { text, attachments }),
  interrupt: () => call<null>("interrupt"),
  clearQueue: () => call<null>("clearQueue"),

  newSession: () => call<EngineStatus>("newSession"),
  listSessions: (limit?: number) => call<SessionSummaryDTO[]>("listSessions", { limit }),
  resumeSession: (id: string) => call<EngineStatus>("resumeSession", { id }),
  deleteSession: (id: string) => call<{ ok: boolean }>("deleteSession", { id }),
  rollback: (messageId: string) => call<{ text: string }>("rollback", { messageId }),
  /** Tell the agent's browser what shape the panel is, so pages fill it. */
  setBrowserViewport: (width: number, height: number, scale?: number) =>
    call<{ ok: boolean }>("setBrowserViewport", { width, height, scale }),
  /** A click, key or scroll from the panel, replayed on the agent's page. */
  browserInput: (input: Record<string, unknown>) => call<boolean>("browserInput", input),
  /** Try Chrome, Edge and Firefox for a session already signed in. */
  importBrowserSession: () =>
    call<{ ok: boolean; source?: string; reason?: string; report?: { browser: string; outcome: string; detail?: string }[] }>("importBrowserSession"),
  /** The real browser a sign-in would open, for the button that offers it. */
  signInBrowserInfo: () => call<{ name: string; channel: string } | null>("signInBrowserInfo"),
  /** Open that browser on OnFlip's own profile and wait for a ChatGPT session. */
  signInWithBrowser: () =>
    call<{ ok: boolean; reason?: string; browser?: string }>("signInWithBrowser"),
  finishBrowserSignIn: () => call<boolean>("finishBrowserSignIn"),
  cancelBrowserSignIn: () => call<boolean>("cancelBrowserSignIn"),


  recentProjects: () => call<RecentProjectDTO[]>("recentProjects"),
  openProject: (dir: string) => call<EngineStatus>("openProject", { dir }),
  openScratch: () => call<EngineStatus>("openScratch"),
  peekSession: (id: string) =>
    call<{ title: string; cwd: string; items: ChatItem[] }>("peekSession", { id }),
  changeCwd: (dir: string) => call<EngineStatus>("changeCwd", { dir }),

  listModels: () => call<ModelDTO[]>("listModels"),
  refreshModels: () => call<ModelDTO[]>("refreshModels"),
  setModel: (slug: string) => call<EngineStatus>("setModel", { slug }),
  setThinking: (level: ThinkingLevel | null) => call<EngineStatus>("setThinking", { level }),
  setApproval: (mode: ApprovalMode) => call<EngineStatus>("setApproval", { mode }),
  setShell: (enabled: boolean) => call<EngineStatus>("setShell", { enabled }),
  setNetwork: (enabled: boolean) => call<EngineStatus>("setNetwork", { enabled }),

  getConfig: () => call<ConfigView>("getConfig"),
  setConfigValue: (key: string, value: unknown) =>
    call<ConfigView>("setConfigValue", { key, value }),
  setRule: (pattern: string, action: RuleAction) =>
    call<ConfigView>("setRule", { pattern, action }),
  deleteRule: (pattern: string) => call<ConfigView>("deleteRule", { pattern }),

  /** One paste-ready block about this install, for bug reports. */
  diagnostics: () => call<{ text: string }>("diagnostics"),
  doctor: () =>
    call<{
      status: "ok" | "warn" | "fail";
      checks: { id: string; title: string; status: "ok" | "warn" | "fail"; message: string }[];
    }>("doctor"),
  deepDoctor: () =>
    call<{
      status: "ok" | "warn" | "fail";
      checks: { id: string; title: string; status: "ok" | "warn" | "fail"; message: string }[];
    }>("deepDoctor"),

  compact: () => call<{ ok: boolean }>("compact"),
  sessionDiff: () => call<FileDiff[]>("sessionDiff"),
  undoPreview: () =>
    call<{ rel: string; existedBefore: boolean; unavailable?: boolean } | null>("undoPreview"),
  undo: () => call<{ ok: boolean; message: string }>("undo"),
  exportTranscript: () => call<ExportResult>("exportTranscript"),

  listChats: (scope: "project" | "all", query?: string) =>
    call<RemoteChatDTO[]>("listChats", { scope, query }),
  attachChat: (id: string, title?: string) =>
    call<EngineStatus>("attachChat", { id, title }),
  listChatProjects: () => call<ChatProjectDTO[]>("listChatProjects"),
  setChatProject: (id: string | null) => call<EngineStatus>("setChatProject", { id }),
  createChatProject: (name: string) => call<EngineStatus>("createChatProject", { name }),

  pickFolder: () => window.onflip.pickFolder(),
  saveFile: (name: string, content: string) => window.onflip.saveFile(name, content),
  restartEngine: (cwd?: string) => window.onflip.restartEngine(cwd),
};
