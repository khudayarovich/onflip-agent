import {
  ToolDefinition,
  ToolContext,
  ToolResult,
  SessionState,
  PermissionDecision,
  PermissionRequest,
} from "../types";
import { FS_TOOLS } from "./fs";
import { SHELL_TOOLS } from "./shell";
import { TODO_TOOLS } from "./todo";
import { WEB_TOOLS } from "./web";
import { BROWSER_TOOLS } from "./browser";
import { MEMORY_TOOLS } from "./memory";
import { TERMINAL_TOOLS } from "./terminal";
import { deliverTools, DeliverFile } from "./deliver";
import { err } from "./util";

export { getShellCwd, setShellCwd, resetShellCwd, killAllJobs, listJobs } from "./shell";
export { globToRegExp } from "./fs";
export { closeAutomationBrowser, automationBrowserOpen } from "./browser";
export { isTerminalTool, TERMINAL_TOOL_NAMES } from "./terminal";

export function createSessionState(): SessionState {
  return { todos: [], snapshots: [], readFiles: new Map() };
}

export interface RegistryOptions {
  /** Working directory tools resolve relative paths against. */
  cwd: string;
  session: SessionState;
  /** Gate every side effect through the approval policy. */
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  /** Aborted when the user interrupts the current turn. */
  signal: AbortSignal;
  /** Streams partial output from long-running tools to the terminal. */
  onProgress?(tool: string, chunk: string): void;
  /** Drop mutating tools from the advertised list (read-only mode). */
  readOnly?: boolean;
  /** Hide the shell tools entirely. */
  disableShell?: boolean;
  /** Hide the network tool entirely. */
  disableNetwork?: boolean;
  /**
   * Hand a file to the person who is not at the machine — the Telegram chat.
   *
   * Absent on the CLI, which has no bot to hand anything to, and the tool is
   * not offered at all when it is: a tool the model can call and nothing can
   * carry out is worse than no tool.
   */
  deliverFile?: DeliverFile;
}

export interface ToolRegistry {
  list: ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  run(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Swap in a new abort signal between turns without rebuilding tools. */
  setSignal(signal: AbortSignal): void;
  /**
   * The registry's own name for one the model wrote — aliases resolved,
   * spelling folded — so the loop can recognise `finish` as `done` without
   * dispatching it.
   */
  canonical(name: string): string;
}

export function createToolRegistry(opts: RegistryOptions): ToolRegistry {
  let signal = opts.signal;

  let tools: ToolDefinition[] = [...FS_TOOLS, ...TODO_TOOLS, ...MEMORY_TOOLS];
  if (!opts.disableShell) tools = [...tools, ...SHELL_TOOLS];
  // Browsing is network access with a mouse attached, so it goes out with
  // the network tools rather than getting a switch of its own.
  if (!opts.disableNetwork) tools = [...tools, ...WEB_TOOLS, ...BROWSER_TOOLS];
  // Listed last, so the closing blocks sit at the end of the roster the model
  // reads; and present in every mode, since they mutate nothing.
  tools = [...tools, ...deliverTools(opts.deliverFile), ...TERMINAL_TOOLS];
  if (opts.readOnly) tools = tools.filter((t) => !t.mutates);

  const byName = new Map(tools.map((t) => [t.name, t]));

  // Names the model is likely to reach for out of habit, mapped to ours.
  const ALIASES: Record<string, string> = {
    read_file: "read",
    readfile: "read",
    view: "read",
    cat: "read",
    write_file: "write",
    writefile: "write",
    create_file: "write",
    edit_file: "edit",
    str_replace: "edit",
    str_replace_editor: "edit",
    apply_patch: "edit",
    multiedit: "multi_edit",
    list_files: "list",
    ls: "list",
    dir: "list",
    search: "grep",
    search_files: "grep",
    ripgrep: "grep",
    rg: "grep",
    find: "glob",
    find_files: "glob",
    run_command: "bash",
    shell: "bash",
    exec: "bash",
    execute: "bash",
    terminal: "bash",
    powershell: "bash",
    cmd: "bash",
    sh: "bash",
    todowrite: "todo_write",
    todoread: "todo_read",
    update_plan: "todo_write",
    webfetch: "web_fetch",
    fetch: "web_fetch",
    curl: "web_fetch",
    websearch: "web_search",
    search_web: "web_search",
    google: "web_search",
    duckduckgo: "web_search",
    download: "download_file",
    wget: "download_file",
    killjob: "kill_job",
    stop_job: "kill_job",
    kill: "kill_job",
    memorize: "remember",
    save_memory: "remember",
    memory: "remember",
    // The closing blocks, under the names other agent protocols give them.
    // A model that has seen Cline or OpenHands reaches for these on its own.
    finish: "done",
    final_answer: "done",
    attempt_completion: "done",
    complete: "done",
    completed: "done",
    submit: "done",
    final: "done",
    end_turn: "done",
    ask: "ask_user",
    ask_followup_question: "ask_user",
    ask_question: "ask_user",
    question: "ask_user",
    clarify: "ask_user",
  };

  // The name as the model may have spelled it — "Read File", "read-file",
  // "Bash" — folded to the one the registry and the explanations below use.
  const canonical = (name: string): string => {
    const norm = name.toLowerCase().replace(/[-\s]/g, "_");
    return ALIASES[norm] ?? norm;
  };

  const resolveName = (name: string): ToolDefinition | undefined =>
    byName.get(name) ?? byName.get(canonical(name));

  // Every tool this registry could have offered, for explaining a hidden one.
  const everyTool = [
    ...FS_TOOLS,
    ...TODO_TOOLS,
    ...MEMORY_TOOLS,
    ...SHELL_TOOLS,
    ...WEB_TOOLS,
    ...BROWSER_TOOLS,
    ...TERMINAL_TOOLS,
  ];

  return {
    list: tools,
    get: resolveName,
    canonical,
    setSignal(next) {
      signal = next;
    },
    async run(name, args) {
      const tool = resolveName(name);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ");
        // A model asking for a hidden tool needs to know why it is missing,
        // not just that the name was wrong.
        const canon = canonical(name);
        if (opts.disableShell && SHELL_TOOLS.some((t) => t.name === canon)) {
          return err(
            "Shell access is disabled for this session. Tell the user they can enable it with /shell on, then continue without running commands."
          );
        }
        if (opts.readOnly && everyTool.some((t) => t.name === canon && t.mutates)) {
          return err(
            "read-only mode is active, so this tool is unavailable. Propose the change in prose instead, or ask the user to run /approve ask."
          );
        }
        return err(`Unknown tool: "${name}". Available tools: ${available}`);
      }

      const ctx: ToolContext = {
        cwd: opts.cwd,
        session: opts.session,
        signal,
        requestPermission: opts.requestPermission,
        onProgress: opts.onProgress ? (chunk) => opts.onProgress!(tool.name, chunk) : undefined,
      };

      try {
        return await tool.run(coerceArgs(tool, args ?? {}), ctx);
      } catch (e) {
        if (signal.aborted) {
          return { output: `${tool.name} was interrupted by the user.`, error: true, denied: true };
        }
        return err(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/**
 * Accept a structured argument the model sent as a JSON string.
 *
 * Measured: a `todo_write` arrived with `todos` as the *text* of a JSON
 * array, the tool answered "`todos` must be an array", and the model spent
 * the rest of the turn trying to re-send it — one of them as bare JSON that
 * ended the turn with the plan unfinished. The schema already says which
 * arguments are arrays and objects, so a string where one of those belongs
 * is unambiguous: parse it, and only accept the result if it matches the
 * declared shape. Anything else is passed through untouched.
 */
function coerceArgs(tool: ToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const props = (tool.parameters?.properties ?? {}) as Record<string, { type?: string }>;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    const want = props[key]?.type;
    if ((want !== "array" && want !== "object") || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith(want === "array" ? "[" : "{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const matches = want === "array" ? Array.isArray(parsed) : parsed && typeof parsed === "object";
      if (!matches) continue;
      out ??= { ...args };
      out[key] = parsed;
    } catch {
      /* not JSON after all — the tool's own error is the better message */
    }
  }
  return out ?? args;
}
