import type { PermissionDecision, PermissionRequest } from "./agent/permissions";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Wall-clock timestamp, used by session persistence and transcripts. */
  createdAt?: number;
  /** Set on synthetic messages carrying tool output back to the model. */
  toolName?: string;
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
}

/** Snapshot of a file taken before a tool mutated it, enabling /undo. */
export interface FileSnapshot {
  path: string;
  /** Null when the file did not exist before the change. */
  before: string | null;
  after: string | null;
  tool: string;
  at: number;
}

export interface SessionState {
  todos: TodoItem[];
  snapshots: FileSnapshot[];
  /** Files the agent has read this session, so it can be told to re-read. */
  readFiles: Map<string, number>;
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
