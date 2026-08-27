import React, { useState } from "react";
import type { ChatItem, TodoItemDTO, ToolCallDTO } from "../../../shared/protocol";
import { DiffView } from "./DiffView";

const TOOL_ICONS: Record<string, string> = {
  read: "📄",
  write: "✏️",
  edit: "✏️",
  multi_edit: "✏️",
  list: "🗂",
  glob: "🔍",
  grep: "🔍",
  bash: "▸",
  job_output: "▸",
  todo_write: "☑",
  todo_read: "☑",
  web_fetch: "🌐",
  browser_open: "🌐",
  browser_snapshot: "🌐",
  browser_click: "🖱",
  browser_type: "⌨",
  browser_key: "⌨",
  browser_screenshot: "📷",
  browser_close: "🌐",
};

const TODO_MARKS: Record<TodoItemDTO["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "✕",
};

export function TodoList({ items }: { items: TodoItemDTO[] }): React.ReactElement {
  return (
    <div className="todo-list">
      {items.map((t) => (
        <div key={t.id} className={`todo-item ${t.status}`}>
          <span className="mark">{TODO_MARKS[t.status]}</span>
          <span>{t.content}</span>
        </div>
      ))}
    </div>
  );
}

export function ToolCard({
  item,
  progress,
}: {
  item: Extract<ChatItem, { type: "tool" }>;
  progress?: string;
}): React.ReactElement {
  const { call, result } = item;
  const running = !result;
  // Diffs and todo lists are worth seeing; raw output starts collapsed.
  const richDisplay =
    result?.display.kind === "diff" || result?.display.kind === "todos";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? richDisplay;

  const stateEl = running ? (
    <span className="tool-state">
      <span className="spinner" />
    </span>
  ) : result.denied ? (
    <span className="tool-state">
      <span className="denied">not allowed</span>
    </span>
  ) : result.error ? (
    <span className="tool-state">
      <span className="err">✕ failed</span>
    </span>
  ) : (
    <span className="tool-state">
      <span className="ok">✓</span>
    </span>
  );

  return (
    <div className="tool-card">
      <button className="head" onClick={() => setOpen(!expanded)}>
        <span className="tool-icon">{TOOL_ICONS[call.tool] ?? "⚙"}</span>
        <span className="tool-name">{call.tool}</span>
        <span className="tool-subject">{result?.title ?? call.subject}</span>
        {stateEl}
      </button>
      {expanded && (result ? <ToolBody item={item} /> : <ArgsBody call={call} />)}
      {running && progress && <div className="progress">{progress}</div>}
    </div>
  );
}

/**
 * What a still-running (or output-less) call is doing — the command, the
 * pattern, the arguments. Without this, expanding a running card showed
 * nothing at all, which read as the click not working.
 */
function ArgsBody({ call }: { call: ToolCallDTO }): React.ReactElement | null {
  const text = describeArgs(call);
  if (!text) return null;
  return (
    <div className="body">
      <pre>{text}</pre>
    </div>
  );
}

function describeArgs(call: ToolCallDTO): string {
  const args = call.args ?? {};
  if (typeof args.command === "string") return args.command;
  if (typeof args.content === "string") return args.content.slice(0, 4000);
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function ToolBody({
  item,
}: {
  item: Extract<ChatItem, { type: "tool" }>;
}): React.ReactElement | null {
  const result = item.result!;
  const display = result.display;

  if (display.kind === "diff") {
    return (
      <div className="body">
        <DiffView diff={display.diff} />
      </div>
    );
  }
  if (display.kind === "todos") {
    return (
      <div className="body">
        <TodoList items={display.items} />
      </div>
    );
  }
  if (display.kind === "text" && display.lines.length) {
    return (
      <div className="body">
        <pre>{display.lines.join("\n")}</pre>
      </div>
    );
  }
  if (result.output.trim()) {
    return (
      <div className="body">
        <pre>{result.output}</pre>
      </div>
    );
  }
  // Nothing came back worth showing — fall back to what was asked.
  return <ArgsBody call={item.call} />;
}
