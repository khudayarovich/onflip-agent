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
    case "bash": {
      const cmd = s(args.command).trim().replace(/\s+/g, " ");
      return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
    }
    case "web_fetch":
      return s(args.url);
    case "browser_open":
      return s(args.url);
    case "browser_click":
    case "browser_type":
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
