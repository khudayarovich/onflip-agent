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
import { err } from "./util";

export { getShellCwd, setShellCwd, resetShellCwd, killAllJobs, listJobs } from "./shell";
export { globToRegExp } from "./fs";

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
}

export interface ToolRegistry {
  list: ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  run(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Swap in a new abort signal between turns without rebuilding tools. */
  setSignal(signal: AbortSignal): void;
}

export function createToolRegistry(opts: RegistryOptions): ToolRegistry {
  let signal = opts.signal;

  let tools: ToolDefinition[] = [...FS_TOOLS, ...TODO_TOOLS];
  if (!opts.disableShell) tools = [...tools, ...SHELL_TOOLS];
  if (!opts.disableNetwork) tools = [...tools, ...WEB_TOOLS];
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
  };

  const resolveName = (name: string): ToolDefinition | undefined => {
    const direct = byName.get(name);
    if (direct) return direct;
    const aliased = ALIASES[name.toLowerCase().replace(/[-\s]/g, "_")];
    return aliased ? byName.get(aliased) : undefined;
  };

  return {
    list: tools,
    get: resolveName,
    setSignal(next) {
      signal = next;
    },
    async run(name, args) {
      const tool = resolveName(name);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ");
        // A model asking for a hidden tool needs to know why it is missing,
        // not just that the name was wrong.
        if (opts.disableShell && ALIASES[name.toLowerCase()] === "bash") {
          return err(
            "Shell access is disabled for this session. Tell the user they can enable it with /shell on, then continue without running commands."
          );
        }
        if (opts.readOnly && ["write", "edit", "multi_edit", "bash"].includes(ALIASES[name] ?? name)) {
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
        return await tool.run(args ?? {}, ctx);
      } catch (e) {
        if (signal.aborted) {
          return { output: `${tool.name} was interrupted by the user.`, error: true, denied: true };
        }
        return err(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
