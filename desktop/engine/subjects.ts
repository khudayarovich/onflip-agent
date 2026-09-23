/**
 * One-line summary of a tool call for the transcript — the path being read,
 * the command being run — so a collapsed tool card says what it did without
 * being expanded.
 */
export function subjectFor(tool: string, args: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (tool) {
    case "read":
    case "write":
    case "edit":
    case "multi_edit":
    case "list":
      return s(args.path) || s(args.file_path);
    case "glob":
      return s(args.pattern);
    case "grep":
      return s(args.pattern);
    case "find_symbol":
      return s(args.symbol) || s(args.name);
    case "bash": {
      const cmd = s(args.command).trim().replace(/\s+/g, " ");
      return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
    }
    case "web_fetch":
      return s(args.url);
    case "browser_open":
      return s(args.url);
    // Never the typed text: see `displayArgs`.
    case "browser_type":
      if (Array.isArray(args.fields)) return `${args.fields.length} fields`;
      return s(args.ref) ? `ref ${s(args.ref)}` : "";
    case "browser_click":
    case "browser_key":
      return s(args.ref) ? `ref ${s(args.ref)}` : s(args.text);
    case "todo_write":
      return "update task list";
    case "todo_read":
      return "read task list";
    case "job_output":
      return s(args.id) ? `job ${s(args.id)}` : "";
    default:
      return "";
  }
}

/** Bullets for a value, as the approval prompt shows a password: its length, not its characters. */
function masked(value: unknown): string {
  return "•".repeat(Math.min(String(value ?? "").length, 12));
}

/**
 * A call's arguments as a tool card may show them.
 *
 * `browser_type` types whatever it is handed, and on a login form that is a
 * password. The approval prompt masks one — it can ask the page which field
 * is a password — and the log never records typed text at all
 * (`loggableArguments`), but the card showed the arguments verbatim: a
 * collapsed card's subject fell back to the text, and an expanded card
 * printed `text: hunter22` for anyone looking at the screen, then again on
 * every replay of the session. A card cannot tell a password field from a
 * search box, so every typed value is masked here; what was typed where was
 * shown in the approval prompt before it ran, and the page it produced is
 * the call's result. Everything else passes through untouched.
 */
export function displayArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool.toLowerCase().replace(/[-\s]/g, "_") !== "browser_type") return args;
  const shown: Record<string, unknown> = { ...args };
  if (shown.text !== undefined) shown.text = masked(shown.text);
  if (Array.isArray(shown.fields)) {
    shown.fields = shown.fields.map((field) => {
      if (!field || typeof field !== "object") return field;
      const entry: Record<string, unknown> = { ...(field as Record<string, unknown>) };
      for (const key of ["text", "value"]) {
        if (entry[key] !== undefined) entry[key] = masked(entry[key]);
      }
      return entry;
    });
  } else if (shown.fields !== undefined) {
    // Still the text of a JSON list at this point: masked whole.
    shown.fields = masked(shown.fields);
  }
  return shown;
}
