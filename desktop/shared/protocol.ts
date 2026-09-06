/**
 * The wire contract between the three processes of the desktop app:
 *
 *   renderer  ⇄  electron main  ⇄  engine (a plain Node child running the
 *                                   OnFlip core out of ../dist)
 *
 * Everything here must be structured-clone / JSON serialisable — these shapes
 * cross two process boundaries. Pure types only; no runtime imports, so both
 * the tsc build (electron/engine) and the Vite build (renderer) can share it.
 */

export type ApprovalMode = "read-only" | "ask" | "auto-edit" | "full-auto" | "yolo";
export type RuleAction = "allow" | "ask" | "deny";
export type ThinkingLevel = "off" | "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "gap";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface FileDiff {
  path: string;
  /** Path relative to the workspace, forward slashes, for display. */
  rel: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated?: boolean;
  /** Persisted snapshot omitted the contents, so a truthful diff is impossible. */
  unavailable?: boolean;
}

// ---------------------------------------------------------------------------
// transcript items
// ---------------------------------------------------------------------------

export interface TodoItemDTO {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export type DisplayPayload =
  | { kind: "text"; lines: string[]; lang?: string }
  | { kind: "diff"; diff: FileDiff }
  | { kind: "todos"; items: TodoItemDTO[] }
  | { kind: "none" };

export interface ToolCallDTO {
  id: string;
  tool: string;
  /** One-line summary of what the call is about (path, command, url). */
  subject: string;
  args: Record<string, unknown>;
}

export interface ToolResultDTO {
  title?: string;
  /** Text handed back to the model; the UI shows it collapsed. */
  output: string;
  error?: boolean;
  denied?: boolean;
  display: DisplayPayload;
}

export type ChatItem =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string }
  /** The agent ended its turn with a question only the user can settle. */
  | { type: "question"; id: string; text: string; options?: string[] }
  | { type: "narration"; id: string; text: string }
  | { type: "tool"; id: string; call: ToolCallDTO; result?: ToolResultDTO }
  | { type: "image"; id: string; dataUrl: string; name: string }
  /** Files a folder-less chat produced this turn, offered as downloads. */
  | { type: "files"; id: string; files: { name: string; path: string; size: number }[] }
  /** How long a finished turn took, rendered as a quiet line under it. */
  | { type: "duration"; id: string; ms: number; interrupted?: boolean }
  | { type: "notice"; id: string; text: string }
  /**
   * `resumable` marks a failure that one more turn would clear, which the
   * chat renders as a Continue button beside the message.
   */
  | { type: "error"; id: string; text: string; resumable?: boolean };

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface ModelDTO {
  slug: string;
  label: string;
  description: string;
  discovered?: boolean;
  /** A ChatGPT Work variant regular chat cannot use; pickers hide these. */
  workOnly?: boolean;
}

/**
 * A prompt that sends itself on a schedule.
 *
 * `description` and `nextRunAt` are worked out in the main process rather
 * than the renderer: the cron parser lives there, and a list that computed
 * "next run" per render would drift a second at a time while it was open.
 */
export interface ScheduleDTO {
  id: string;
  prompt: string;
  cron: string;
  /** The expression in words, or the expression itself when it has no plain reading. */
  description: string;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: "sent" | "queued" | "missed" | "failed";
  lastDetail?: string;
}

export interface SessionSummaryDTO {
  id: string;
  title: string;
  cwd: string;
  model: string;
  updatedAt: number;
  messageCount: number;
}

export interface RecentProjectDTO {
  cwd: string;
  sessions: number;
  updatedAt: number;
  exists: boolean;
}

export interface ChatProjectDTO {
  id: string;
  name: string;
}

export interface RemoteChatDTO {
  id: string;
  title: string;
  updatedAt?: number;
  projectName?: string;
}

export interface EngineStatus {
  version: string;
  cwd: string;
  /** True when this is a folder-less chat in a private scratch workspace. */
  scratch?: boolean;
  /** Transcript size in characters, and the size at which compaction fires. */
  contextChars?: number;
  contextBudget?: number;
  /**
   * The account is on a plan whose extras are rationed (Free, Go): uploads,
   * reasoning variants and the metered models are all turned off so the run
   * stays on the unlimited path. The UI greys out what it cannot offer.
   */
  planRationed?: boolean;
  /**
   * Which chat service is answering: "chatgpt" or "deepseek".
   *
   * The UI uses it for the things that differ per service rather than per
   * account — the reasoning chip offers a switch on DeepSeek and a dial on
   * ChatGPT, because that is what each one actually has.
   */
  provider?: string;
  /** Heading and body for the card shown on a control the plan rations. */
  planLimitTitle?: string;
  planLimitNote?: string;
  home: string;
  sessionId: string;
  sessionTitle: string;
  /** Set when the session continues a chatgpt.com conversation. */
  chatId?: string;
  model: string;
  thinking?: ThinkingLevel;
  approvalMode: ApprovalMode;
  shellEnabled: boolean;
  networkEnabled: boolean;
  maxIterations: number;
  transport: string;
  gitBranch?: string;
  gitDirty?: boolean;
  instructionSources: string[];
  chatProject?: ChatProjectDTO;
  cooldownUntil?: number;
  headed: boolean;
  busy: boolean;
  queued: string[];
  snapshotCount: number;
  todoCount: number;
  /**
   * Whether OnFlip currently holds a usable ChatGPT session — the account
   * menu offers signing in or signing out on the strength of this.
   */
  signedIn: boolean;
  /** Who the ChatGPT session belongs to, when it could be identified. */
  account: { name?: string; email?: string } | null;
  /** Requests sent through OnFlip, counted locally per account. */
  usage: { today: number; week: number; month: number; total: number; since: number };
}

export type ConnectState = "connecting" | "ready" | "signed-out" | "error";

/** How far a user message got: accepted by ChatGPT, answered, or neither. */
export type DeliveryState = "sent" | "read" | "failed";

/** A click, key or scroll from the browser panel, replayed on the agent's page. */
export interface BrowserInputDTO {
  kind: "click" | "dblclick" | "contextmenu" | "wheel" | "key" | "text";
  /** Position as a fraction of the frame, 0..1. */
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  /** A Playwright key name, modifiers composed ("Control+a"). */
  key?: string;
  text?: string;
}

export interface BrowserImportResult {
  ok: boolean;
  source?: string;
  reason?: string;
  report?: { browser: string; outcome: string; detail?: string }[];
}

// ---------------------------------------------------------------------------
// approvals (engine → UI request; the UI answers)
// ---------------------------------------------------------------------------

export interface ApprovalRequestDTO {
  kind: "read" | "write" | "command" | "network";
  tool: string;
  subject: string;
  reason: string;
  dangerous: boolean;
  detail?: string[];
  /** Rendered diff for writes, when the engine could compute one. */
  preview?: FileDiff;
  /** What "always allow" would remember, when remembering is possible. */
  rememberLabel?: string;
}

export interface ApprovalDecisionDTO {
  allow: boolean;
  remember?: boolean;
  /** Deny and also stop the whole turn. */
  abort?: boolean;
}

// ---------------------------------------------------------------------------
// events (engine → UI, fire-and-forget)
// ---------------------------------------------------------------------------

export type EngineEvent =
  | { event: "connect"; data: { state: ConnectState; detail?: string } }
  | { event: "status"; data: EngineStatus }
  | { event: "transcript"; data: { items: ChatItem[] } }
  | { event: "item"; data: ChatItem }
  | { event: "tool-update"; data: { id: string; result: ToolResultDTO } }
  | { event: "tool-progress"; data: { id: string; chunk: string } }
  | { event: "thinking"; data: { iteration: number } }
  | { event: "delta"; data: { tail: string } }
  | { event: "delivery"; data: { id: string; state: DeliveryState } }
  /** The turn stopped while a prompt was up; the prompt is void. */
  | { event: "approval-cancelled"; data: Record<string, never> }
  /** Where a browser sign-in has got to. */
  | { event: "sign-in"; data: { state: "waiting" | "verifying" | "downloading" } }
  | {
      event: "turn";
      data: {
        state: "start" | "end";
        interrupted?: boolean;
        exhausted?: boolean;
        iterations?: number;
        error?: string;
      };
    }
  | { event: "todos"; data: { items: TodoItemDTO[] } }
  | {
      event: "browser-frame";
      data: {
        image?: string;
        url?: string;
        title?: string;
        note?: string;
        closed?: boolean;
        live?: boolean;
      };
    }
  | { event: "log"; data: { line: string } };

// ---------------------------------------------------------------------------
// config view for the settings panel
// ---------------------------------------------------------------------------

export interface ConfigView {
  headed: boolean;
  browserHeadless: boolean;
  maxIterations: number;
  replyTimeout: number;
  compactAfterChars: number;
  autoResume: boolean;
  rules: { pattern: string; action: RuleAction }[];
  allowedCommands: string[];
  allowedWriteDirs: string[];
}

export interface ExportResult {
  markdown: string;
  suggestedName: string;
}

/** Everything the renderer can ask of the engine, by method name. */
export interface EngineMethods {
  init: { params: Record<string, never>; result: EngineStatus };
  send: { params: { text: string; attachments?: string[] }; result: { queued: boolean } };
  interrupt: { params: Record<string, never>; result: null };
  clearQueue: { params: Record<string, never>; result: null };

  newSession: { params: Record<string, never>; result: EngineStatus };
  listSessions: { params: { limit?: number }; result: SessionSummaryDTO[] };
  resumeSession: { params: { id: string }; result: EngineStatus };
  peekSession: {
    params: { id: string };
    result: { title: string; cwd: string; items: ChatItem[] };
  };
  deleteSession: { params: { id: string }; result: { ok: boolean } };
  /** Drop everything after a user message, handing its text back for editing. */
  rollback: { params: { messageId: string }; result: { text: string } };

  /** Signing in and out, and the agent's browser panel. */
  importBrowserSession: { params: Record<string, never>; result: BrowserImportResult };
  applySignIn: {
    params: {
      cookies: { name: string; value: string }[];
      account?: { name?: string; email?: string };
    };
    result: { ok: boolean };
  };
  applySignOut: { params: Record<string, never>; result: { ok: boolean } };
  /** The real browser a sign-in would open, or null when none is installed. */
  signInBrowserInfo: { params: Record<string, never>; result: { name: string; channel: string } | null };
  /** Open that browser on OnFlip's profile and wait for a ChatGPT session. */
  signInWithBrowser: {
    params: Record<string, never>;
    result: { ok: boolean; reason?: string; browser?: string };
  };
  /** The user says they are done in the window: close it and check. */
  finishBrowserSignIn: { params: Record<string, never>; result: boolean };
  cancelBrowserSignIn: { params: Record<string, never>; result: boolean };
  setBrowserViewport: {
    params: { width: number; height: number; scale?: number };
    result: { ok: boolean };
  };
  browserInput: { params: BrowserInputDTO; result: boolean };

  recentProjects: { params: Record<string, never>; result: RecentProjectDTO[] };
  openProject: { params: { dir: string }; result: EngineStatus };
  /** A folder-less chat in a private scratch workspace. */
  openScratch: { params: Record<string, never>; result: EngineStatus };
  changeCwd: { params: { dir: string }; result: EngineStatus };

  listModels: { params: Record<string, never>; result: ModelDTO[] };
  refreshModels: { params: Record<string, never>; result: ModelDTO[] };
  setModel: { params: { slug: string }; result: EngineStatus };
  setThinking: { params: { level: ThinkingLevel | null }; result: EngineStatus };
  setApproval: { params: { mode: ApprovalMode }; result: EngineStatus };
  setShell: { params: { enabled: boolean }; result: EngineStatus };
  setNetwork: { params: { enabled: boolean }; result: EngineStatus };

  getConfig: { params: Record<string, never>; result: ConfigView };
  setConfigValue: { params: { key: string; value: unknown }; result: ConfigView };
  setRule: { params: { pattern: string; action: RuleAction }; result: ConfigView };
  deleteRule: { params: { pattern: string }; result: ConfigView };

  compact: { params: Record<string, never>; result: { ok: boolean } };
  sessionDiff: { params: Record<string, never>; result: FileDiff[] };
  undoPreview: {
    params: Record<string, never>;
    result: { rel: string; existedBefore: boolean; unavailable?: boolean } | null;
  };
  undo: { params: Record<string, never>; result: { ok: boolean; message: string } };
  exportTranscript: { params: Record<string, never>; result: ExportResult };

  listChats: {
    params: { scope: "project" | "all"; query?: string };
    result: RemoteChatDTO[];
  };
  attachChat: { params: { id: string; title?: string }; result: EngineStatus };
  listChatProjects: { params: Record<string, never>; result: ChatProjectDTO[] };
  setChatProject: { params: { id: string | null; name?: string }; result: EngineStatus };
  createChatProject: { params: { name: string }; result: EngineStatus };

  /** One paste-ready block describing this install, for bug reports. */
  diagnostics: { params: Record<string, never>; result: { text: string } };
  /** Health checks that are run rather than printed; see src/chatgpt/doctor.ts. */
  doctor: {
    params: Record<string, never>;
    result: {
      status: "ok" | "warn" | "fail";
      checks: { id: string; title: string; status: "ok" | "warn" | "fail"; message: string }[];
    };
  };
  /** The same checks plus a read-only look at ChatGPT's live page. */
  deepDoctor: {
    params: Record<string, never>;
    result: {
      status: "ok" | "warn" | "fail";
      checks: { id: string; title: string; status: "ok" | "warn" | "fail"; message: string }[];
    };
  };

  status: { params: Record<string, never>; result: EngineStatus };
}

export type EngineMethodName = keyof EngineMethods;
