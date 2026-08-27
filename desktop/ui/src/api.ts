import type {
  ApprovalMode,
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
  send: (text: string) => call<{ queued: boolean }>("send", { text }),
  interrupt: () => call<null>("interrupt"),
  clearQueue: () => call<null>("clearQueue"),

  newSession: () => call<EngineStatus>("newSession"),
  listSessions: (limit?: number) => call<SessionSummaryDTO[]>("listSessions", { limit }),
  resumeSession: (id: string) => call<EngineStatus>("resumeSession", { id }),
  deleteSession: (id: string) => call<{ ok: boolean }>("deleteSession", { id }),
  rollback: (messageId: string) => call<{ text: string }>("rollback", { messageId }),
  signIn: () => call<{ ok: boolean }>("signIn"),

  recentProjects: () => call<RecentProjectDTO[]>("recentProjects"),
  openProject: (dir: string) => call<EngineStatus>("openProject", { dir }),
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

  compact: () => call<{ ok: boolean }>("compact"),
  sessionDiff: () => call<FileDiff[]>("sessionDiff"),
  undoPreview: () =>
    call<{ rel: string; existedBefore: boolean } | null>("undoPreview"),
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
