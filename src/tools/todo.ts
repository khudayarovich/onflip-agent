import { ToolDefinition, TodoItem, TodoStatus } from "../types";
import { err, ok } from "./util";

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

/**
 * A shared task list. It gives the model somewhere to keep multi-step plans
 * that survive across turns, and gives the user a visible progress readout.
 */
export const todoWriteTool: ToolDefinition = {
  name: "todo_write",
  description:
    "Create or update the task list for the current job. Send the complete list every time — it replaces the previous one. Use it for any task needing three or more steps: write the plan first, then mark exactly one item in_progress as you work, and completed the moment it is done.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The full task list, in execution order",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What needs doing, as an imperative phrase" },
            status: {
              type: "string",
              enum: STATUSES,
              description: "pending | in_progress | completed | cancelled",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run(args, ctx) {
    if (!Array.isArray(args.todos)) return err("`todos` must be an array");

    const items: TodoItem[] = [];
    for (const [i, raw] of (args.todos as unknown[]).entries()) {
      // A bare string is a clear enough shorthand to honour. Anything else
      // that is not an object gets told the shape — a `null` here used to
      // crash the tool instead of answering.
      const t: Record<string, unknown> | null =
        typeof raw === "string"
          ? { content: raw }
          : raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
      if (!t) {
        const what = raw === null ? "null" : Array.isArray(raw) ? "an array" : `a ${typeof raw}`;
        return err(
          `todos[${i}] is ${what}, not a task. Each item must be an object like {"content": "...", "status": "pending"}; resend the whole list.`
        );
      }
      const content = String(t.content ?? "").trim();
      if (!content) return err(`todos[${i}]: \`content\` must be non-empty`);
      const status = String(t.status ?? "pending") as TodoStatus;
      if (!STATUSES.includes(status)) {
        return err(`todos[${i}]: invalid status "${status}". Use one of: ${STATUSES.join(", ")}`);
      }
      items.push({ id: `t${i + 1}`, content, status });
    }

    const inProgress = items.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      return err(
        `${inProgress} tasks are marked in_progress. Exactly one task may be in progress at a time.`
      );
    }

    ctx.session.todos = items;

    const done = items.filter((t) => t.status === "completed").length;
    const summary = items
      .map((t) => `${statusMark(t.status)} ${t.content}`)
      .join("\n");
    return ok(`Task list updated (${done}/${items.length} complete).\n${summary}`, {
      title: `${done}/${items.length} complete`,
      display: { kind: "todos", items },
    });
  },
};

export const todoReadTool: ToolDefinition = {
  name: "todo_read",
  description: "Read the current task list. Takes no arguments.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const items = ctx.session.todos;
    if (items.length === 0) {
      return ok("The task list is empty. Use `todo_write` to create one.");
    }
    return ok(items.map((t) => `${statusMark(t.status)} ${t.content}`).join("\n"), {
      title: `${items.filter((t) => t.status === "completed").length}/${items.length} complete`,
      display: { kind: "todos", items },
    });
  },
};

function statusMark(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "cancelled":
      return "[-]";
    default:
      return "[ ]";
  }
}

export const TODO_TOOLS: ToolDefinition[] = [todoWriteTool, todoReadTool];
