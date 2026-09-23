import type { PermissionDecision, PermissionRequest } from "./agent/permissions";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Wall-clock timestamp, used by session persistence and transcripts. */
  createdAt?: number;
  /** Set on synthetic messages carrying tool output back to the model. */
  toolName?: string;
  /**
   * Characters cut out of the middle of this tool result to save the
   * conversation from being summarised. Also the mark that stops it being
   * trimmed twice, which would compound until nothing readable was left.
   */
  prunedChars?: number;
  /** Where the whole of this result was written before it was cut down. */
  spilledTo?: string;
  /**
   * Files the person attached to this message, by path. The text only names
   * them for the model; without the paths an edit or a resend had nothing to
   * attach again.
   */
  attachments?: string[];
}

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  /** Correlates a call with its result across the transcript. */
  id?: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Structured payload so the terminal can render more than a text blob. */
export type ToolDisplay =
  | { kind: "text"; lines: string[]; lang?: string }
  | { kind: "diff"; path: string; oldText: string; newText: string }
  | { kind: "todos"; items: TodoItem[] }
  | { kind: "none" };

export interface ToolResult {
  /** Text handed back to the model. */
  output: string;
  error?: boolean;
  /** Short subject shown beside the tool name in the transcript. */
  title?: string;
  /** Rich rendering payload; falls back to `output` when absent. */
  display?: ToolDisplay;
  /** Set when the user declined the action, so the loop can react. */
  denied?: boolean;
  /**
   * The command hit its time limit and was killed.
   *
   * Reported separately from `error` because the loop treats it differently:
   * a command that fails is information, a command that times out is two
   * minutes gone, and two of those in one turn is a pattern worth naming
   * before a third.
   */
  timedOut?: boolean;
  /**
   * The exit code of a command the tool ran to completion; null when the
   * process ended without one. Absent when no command finished, such as a
   * background start. The loop reads it when deciding whether a `done`
   * sent beside the command can end the turn: only a plain 0 counts.
   */
  exitCode?: number | null;
  /**
   * The absolute path of a file this result carries in full.
   *
   * Set by `read` when it sent a whole file, so the loop can note which
   * message holds that text: a later read of the same file can then send
   * only what changed, for as long as that message is still in front of the
   * model. See `FullRead`.
   */
  fullRead?: string;
}

/**
 * A whole-file read the model has in its conversation.
 *
 * The text is kept so a second read can be answered with the difference.
 * `messageId` is the transcript message carrying the read, filled in by the
 * loop once the result is in the history — until then, and after that
 * message is trimmed, compacted away or rewound, the entry must not be used.
 */
export interface FullRead {
  content: string;
  messageId?: string;
}

/** Filesystem identity captured around a write, including symlink targets. */
export interface FileRevision {
  exists: boolean;
  contents: string | null;
  pathIdentity: string | null;
  targetIdentity: string | null;
  ancestorIdentity: string | null;
}

export type FileIdentity = Omit<FileRevision, "contents">;

/** Snapshot of a file taken before a tool mutated it, enabling /undo. */
export interface FileSnapshot {
  path: string;
  /** Null when the file did not exist before the change. */
  before: string | null;
  after: string | null;
  /** Identity immediately after the write, so Undo cannot clobber a later edit. */
  afterRevision?: FileIdentity;
  /** Capturing the post-write identity failed; Undo must refuse this snapshot. */
  revisionUnavailable?: boolean;
  /** The contents were deliberately omitted from persisted session data. */
  contentsOmitted?: boolean;
  tool: string;
  at: number;
}

export interface SessionState {
  todos: TodoItem[];
  snapshots: FileSnapshot[];
  /** Files the agent has read this session, so it can be told to re-read. */
  readFiles: Map<string, number>;
  /**
   * Whole-file reads still in the conversation, by absolute path.
   *
   * Optional so that state built by hand (tests, older callers) keeps
   * working: without it every read is simply a full read.
   */
  fullReads?: Map<string, FullRead>;
}

export interface ToolContext {
  cwd: string;
  session: SessionState;
  /** Aborted when the user interrupts the turn. */
  signal: AbortSignal;
  /** Gate for side effects; resolves to the user's decision. */
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  /** Incremental output while a long-running tool is still working. */
  onProgress?(chunk: string): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Skipped when listing tools to the model in read-only mode. */
  mutates?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface SendTurnResult {
  content: string;
  messageId: string;
  conversationId: string;
}

export type { PermissionDecision, PermissionRequest };
