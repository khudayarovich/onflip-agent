import React, { useContext, useState } from "react";
import type { ChatItem, TodoItemDTO, ToolCallDTO } from "../../../shared/protocol";
import { LangContext } from "../i18n";
import { toolLabel } from "../toolNames";
import { DiffView } from "./DiffView";
import {
  Camera,
  Check,
  CheckSquare,
  ChevronDown,
  CircleCheck,
  CircleEmpty,
  CircleHalf,
  CircleSlash,
  Close,
  Cursor,
  FileText,
  Gear,
  Globe,
  Keyboard,
  ListIcon,
  Pencil,
  Search,
  Terminal,
} from "./icons";

type IconFn = (props: { size?: number }) => React.ReactElement;

const TOOL_ICONS: Record<string, IconFn> = {
  read: FileText,
  write: Pencil,
  edit: Pencil,
  multi_edit: Pencil,
  list: ListIcon,
  glob: Search,
  grep: Search,
  bash: Terminal,
  job_output: Terminal,
  todo_write: CheckSquare,
  todo_read: CheckSquare,
  web_fetch: Globe,
  browser_open: Globe,
  browser_snapshot: Globe,
  browser_click: Cursor,
  browser_type: Keyboard,
  browser_key: Keyboard,
  browser_screenshot: Camera,
  browser_close: Globe,
};

const TODO_MARKS: Record<TodoItemDTO["status"], IconFn> = {
  pending: CircleEmpty,
  in_progress: CircleHalf,
  completed: CircleCheck,
  cancelled: CircleSlash,
};

export function TodoList({ items }: { items: TodoItemDTO[] }): React.ReactElement {
  return (
    <div className="todo-list">
      {items.map((t) => {
        const Mark = TODO_MARKS[t.status];
        return (
          <div key={t.id} className={`todo-item ${t.status}`}>
            <span className="mark">
              <Mark size={13} />
            </span>
            <span>{t.content}</span>
          </div>
        );
      })}
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
  const lang = useContext(LangContext);
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
      <span className="err">
        <Close size={12} /> failed
      </span>
    </span>
  ) : (
    <span className="tool-state">
      <span className="ok">
        <Check size={13} />
      </span>
    </span>
  );

  const Icon = TOOL_ICONS[call.tool] ?? Gear;

  return (
    <div className="tool-card">
      <button
        className="head"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
      >
        <span className="tool-icon">
          <Icon size={14} />
        </span>
        <span className="tool-name">{toolLabel(call.tool, lang)}</span>
        <span className="tool-subject">{result?.title ?? call.subject}</span>
        {stateEl}
        {/* The card has always been a disclosure; nothing on it said so. The
            command's own icon was "▸", which reads as a collapsed arrow that
            never opens. One arrow, at the end where a disclosure's arrow
            belongs, rotated by CSS when the body is showing. */}
        <span className={`tool-chevron${expanded ? " open" : ""}`}>
          <ChevronDown size={14} />
        </span>
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
