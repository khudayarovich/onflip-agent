import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition, ToolResult } from "../types";
import { err, ok, denied, asNumber, asBool, clip } from "./util";
import { assessCommand } from "../agent/permissions";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_LINES = 400;

/** Marker used to read the shell's final working directory back out. */
const CWD_MARKER = "__ONFLIP_CWD__";

export interface ShellHost {
  file: string;
  args: (command: string) => string[];
  /** Command suffix that prints the resulting working directory. */
  cwdProbe: string;
  name: string;
}

/**
 * Make a PowerShell child speak UTF-8 in every direction it has.
 *
 * `InputEncoding` is here for completeness — it governs stdin, which a
 * command reading input relies on. It is explicitly *not* the fix for the
 * mojibake reported from a Russian-locale Windows ("boot РІР‚вЂќ degraded",
 * an em dash encoded to UTF-8 and decoded as cp1251 twice over). That was
 * measured here against a console forced to cp1251, and none of the four
 * encoding settings changed the result: with output redirected to a pipe,
 * which is how OnFlip always reads it, the bytes come through untouched.
 * So the corruption happens somewhere else — most likely the text was
 * already mangled in the file the program was printing. `looksMisdecoded`
 * below exists to find out which, rather than guessing again.
 */
const WINDOWS_UTF8_PRELUDE =
  "$ProgressPreference='SilentlyContinue'; " +
  "chcp 65001 > $null; " +
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
  "[Console]::InputEncoding=[Text.Encoding]::UTF8; " +
  "$OutputEncoding=[Text.Encoding]::UTF8; " +
  // `chcp` is a native program, so it leaves $LASTEXITCODE at 0 — which the
  // exit-code probe below would read as "a program ran and succeeded" even
  // when the command was a cmdlet that failed. Cleared, so only programs the
  // command itself ran are counted.
  "$global:LASTEXITCODE=$null; ";

/**
 * Does this output look like UTF-8 that something decoded as a byte
 * codepage?
 *
 * The signature is narrow on purpose. `вЂ` and `Ð` are what the leading
 * bytes of common UTF-8 punctuation become when read as cp1251 or
 * latin-1, and neither sequence occurs in real Russian, Ukrainian or any
 * other text worth reading. Saying so matters more than it sounds: a
 * model that is handed mangled characters copies them faithfully into the
 * next file it writes, and the corruption becomes permanent.
 */
export function looksMisdecoded(text: string): boolean {
  return /вЂ|РІР|[ÐÃ][\u0080-\u00bf]/.test(text);
}

export function shellHost(): ShellHost {
  if (process.platform === "win32") {
    const usePwsh = Boolean(process.env.ONFLIP_USE_PWSH);
    const file = usePwsh ? "pwsh.exe" : "powershell.exe";
    return {
      name: usePwsh ? "pwsh" : "powershell",
      file,
      args: (command) => [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        // PowerShell writes in the OEM codepage unless told otherwise, so
        // every non-ASCII character came back as `?` — Russian output was
        // unreadable in the chat. The terminal panel already does this; the
        // agent's own shell had been left behind.
        `${WINDOWS_UTF8_PRELUDE}${command}`,
      ],
      // The probe runs after the command, so on its own it would make every
      // command exit 0 — a failed build reported as success, and the model
      // moving on. The status is captured first: `$?` before anything else
      // can overwrite it (it is the cmdlet verdict), $LASTEXITCODE for a
      // native program's own code.
      //
      // The code then travels *in the marker* rather than through `exit`.
      // `exit` discards PowerShell's pending formatter output, and the
      // formatter is how every object-producing command prints: measured,
      // `Get-ChildItem | Select-Object Name, Length` came back completely
      // empty, and so did the cwd marker on the same line. That is most of
      // idiomatic PowerShell silently returning nothing — seen in a real
      // session where the agent asked for file sizes three times, got blank
      // output each time, and burned four turns deciding its own code was
      // broken. Strings and booleans survived, which is what made it look
      // like an occasional glitch rather than a rule.
      //
      // Without `exit` the script ends normally, the formatter drains, and
      // the marker is the last line written. Verified against a failing
      // cmdlet (1), a native `exit 3` (3) and success (0).
      cwdProbe:
        "; $__ok = $?; $__rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($__ok) { 0 } else { 1 }" +
        `; Write-Output ("${CWD_MARKER}:" + $__rc + ":" + (Get-Location).Path)`,
    };
  }
  const file = process.env.SHELL && process.env.SHELL.includes("bash") ? process.env.SHELL : "/bin/sh";
  return {
    name: path.basename(file),
    file,
    args: (command) => ["-c", command],
    // Same shape as the PowerShell probe: keep the command's status, print
    // the directory, then exit with what the command exited with.
    // Same marker shape as Windows so one parser reads both. `exit` is kept
    // here because a POSIX shell has no deferred formatter to lose.
    cwdProbe: `; __rc=$?; printf '${CWD_MARKER}:%s:%s\\n' "$__rc" "$PWD"; exit $__rc`,
  };
}

/**
 * Working directory carried across shell calls within one session, so a `cd`
 * behaves the way it does in a real terminal.
 */
let sessionCwd: string | null = null;

export function getShellCwd(fallback: string): string {
  return sessionCwd ?? fallback;
}

export function setShellCwd(dir: string): void {
  sessionCwd = dir;
}

export function resetShellCwd(): void {
  sessionCwd = null;
}

/**
 * A directory a shell can actually be started in.
 *
 * `cd HKLM:\Software` reports a path just like a real one does, and so does
 * a folder that a later command deletes. Once either is stored as the
 * session's directory every spawn fails with ENOENT — including the `cd`
 * that would fix it — so a path is only kept when it is a filesystem
 * directory, and on Windows a drive-letter or UNC one.
 */
function isUsableDirectory(dir: string): boolean {
  if (process.platform === "win32" && !/^[a-zA-Z]:[\\/]/.test(dir) && !/^(?:\\\\|\/\/)[^\\/]/.test(dir)) {
    return false;
  }
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// background jobs
// ---------------------------------------------------------------------------

interface BackgroundJob {
  id: string;
  command: string;
  child: ChildProcess;
  output: string[];
  exitCode: number | null;
  startedAt: number;
  /** Index the caller has already consumed, so reads are incremental. */
  cursor: number;
}

const jobs = new Map<string, BackgroundJob>();
let jobCounter = 0;

/** Stop the shell and every descendant it started. */
function killProcessTree(child: ChildProcess, force = false): void {
  if (!child.pid) return;
  const fallback = () => {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  };

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", fallback);
      killer.once("exit", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }

  try {
    // Shells are detached into their own process group on POSIX.
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    fallback();
  }
}

export function killAllJobs(): void {
  for (const job of jobs.values()) {
    if (job.exitCode === null) {
      killProcessTree(job.child, true);
    }
  }
  jobs.clear();
}

export function listJobs(): { id: string; command: string; running: boolean }[] {
  return [...jobs.values()].map((j) => ({
    id: j.id,
    command: j.command,
    running: j.exitCode === null,
  }));
}

// ---------------------------------------------------------------------------
// bash / run_command
// ---------------------------------------------------------------------------

interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  cwd: string | null;
}

function execute(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  onProgress?: (chunk: string) => void
): Promise<ExecOutcome> {
  const host = shellHost();
  return new Promise<ExecOutcome>((resolve) => {
    const child = spawn(host.file, host.args(command + host.cwdProbe), {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      // stdin is closed so a command that waits on input fails fast instead of
      // hanging until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ONFLIP: "1", TERM: process.env.TERM ?? "dumb" },
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, true);
    }, timeout);

    const onAbort = () => {
      aborted = true;
      killProcessTree(child, true);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      stdout += text;
      onProgress?.(text);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      stderr += text;
      onProgress?.(text);
    });

    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);

      // Pull the trailing probe out of stdout. It carries both the working
      // directory and the command's real exit code — see `cwdProbe`, where
      // the code travels this way because `exit` would discard PowerShell's
      // pending object output.
      let resolvedCwd: string | null = null;
      let markerCode: number | null = null;
      const lines = stdout.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const idx = lines[i].indexOf(`${CWD_MARKER}:`);
        if (idx !== -1) {
          const payload = lines[i].slice(idx + CWD_MARKER.length + 1).trim();
          // Only the first colon separates the code from the path: a Windows
          // path is full of them.
          const split = payload.indexOf(":");
          const rc = split === -1 ? "" : payload.slice(0, split);
          if (/^-?\d+$/.test(rc)) {
            markerCode = Number(rc);
            resolvedCwd = payload.slice(split + 1).trim();
          } else {
            // A probe from before the code was added, or a mangled line.
            // The path is still worth having.
            resolvedCwd = payload;
          }
          // Output without a trailing newline shares the marker's line, so
          // only the marker goes — dropping the whole line turned
          // `Write-Host -NoNewline hello` into "(no output)".
          if (idx > 0) lines[i] = lines[i].slice(0, idx);
          else lines.splice(i, 1);
          break;
        }
      }
      resolve({
        stdout: lines.join("\n"),
        stderr,
        // The marker is the authority when it arrived: the process itself now
        // exits 0 on Windows whatever the command did.
        code: markerCode ?? code,
        timedOut,
        aborted,
        cwd: resolvedCwd,
      });
    };

    child.on("error", (e) => {
      stderr += `\nFailed to start ${host.file}: ${e.message}`;
      done(127);
    });
    child.on("close", (code) => done(code));
  });
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    process.platform === "win32"
      ? "Run a shell command on the user's machine via PowerShell and return stdout, stderr and the exit code. Working directory persists between calls, so `cd` works as it does in a real terminal. Use this for builds, tests, git, package managers, and any system inspection."
      : "Run a shell command on the user's machine and return stdout, stderr and the exit code. Working directory persists between calls, so `cd` works as it does in a real terminal. Use this for builds, tests, git, package managers, and any system inspection.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute" },
      description: {
        type: "string",
        description: "Five to ten words describing what this command does, shown to the user",
      },
      timeout_ms: {
        type: "number",
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})`,
      },
      background: {
        type: "boolean",
        description: "Start the command in the background and return a job id immediately. Use for dev servers and watchers.",
      },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    const command = String(args.command ?? "").trim();
    if (!command) return err("`command` must be non-empty");

    const timeout = Math.min(
      MAX_TIMEOUT,
      Math.max(1_000, asNumber(args.timeout_ms) ?? DEFAULT_TIMEOUT)
    );
    let cwd = getShellCwd(ctx.cwd);
    // The stored directory can stop existing between calls — a build that
    // removes its own output folder, say. Start over from the session root
    // rather than failing every command from here on, and say so, since the
    // model's relative paths were written against the old one.
    let cwdNote = "";
    if (cwd !== ctx.cwd && !isUsableDirectory(cwd)) {
      cwdNote = `[OnFlip] The working directory ${cwd} no longer exists; running in ${ctx.cwd} instead.`;
      resetShellCwd();
      cwd = ctx.cwd;
    }
    const danger = assessCommand(command);

    const decision = await ctx.requestPermission({
      kind: "command",
      tool: "bash",
      subject: command,
      detail: [
        typeof args.description === "string" && args.description.trim()
          ? String(args.description).trim()
          : "",
        `in ${cwd}`,
        ...(danger.dangerous ? [`flagged: ${danger.reasons.join(", ")}`] : []),
      ].filter(Boolean),
    });
    if (!decision.allow) return denied("Command", decision.reason);

    if (asBool(args.background)) {
      const started = await startBackground(command, cwd);
      return cwdNote ? { ...started, output: `${cwdNote}\n${started.output}` } : started;
    }

    const result = await execute(command, cwd, timeout, ctx.signal, ctx.onProgress);

    if (result.cwd && result.cwd !== cwd && isUsableDirectory(result.cwd)) setShellCwd(result.cwd);

    if (result.aborted) {
      return { output: "Command interrupted by the user.", error: true, denied: true };
    }

    const parts: string[] = [];
    const stdout = result.stdout.trimEnd();
    const stderr = result.stderr.trimEnd();
    if (stdout) parts.push(clip(stdout, MAX_OUTPUT_LINES));
    if (stderr) parts.push(`[stderr]\n${clip(stderr, Math.floor(MAX_OUTPUT_LINES / 2))}`);
    if (result.timedOut) parts.push(`[timed out after ${timeout}ms — process killed]`);
    if (looksMisdecoded(result.stdout) || looksMisdecoded(result.stderr)) {
      parts.push(
        "[OnFlip] Some characters above look mis-decoded — UTF-8 text read as a byte codepage. " +
          "Treat them as unreliable, and do not copy them into a file: check the source with `read` first."
      );
    }
    if (parts.length === 0) parts.push("(no output)");
    if (cwdNote) parts.unshift(cwdNote);
    parts.push(`[exit code ${result.code ?? "unknown"}]`);

    const failed = result.timedOut || (result.code !== 0 && result.code !== null);
    // The header line already shows the command, so the footer reports the
    // outcome instead of repeating it.
    const summary = result.timedOut
      ? `timed out after ${timeout}ms`
      : `exit ${result.code ?? "?"}`;
    const streams = [stdout, stderr].filter(Boolean).join("\n");
    return {
      output: parts.join("\n"),
      error: failed,
      title: summary,
      display: {
        kind: "text",
        // Only the streams themselves — the exit code lives in the footer, so
        // repeating it in the body would just be noise.
        lines: streams ? streams.split("\n") : ["(no output)"],
      },
    };
  },
};

/**
 * How long a background command gets to prove it is still alive.
 *
 * Sized from the slow case rather than the obvious one. A bare PowerShell
 * starts in 125ms, but a *failing* command takes far longer than that to
 * fail: measured on this machine, `definitelynotarealprogram --serve` needed
 * 761ms, because PowerShell searches PATH and then builds a full
 * CommandNotFoundException record before exiting. A 400ms window let exactly
 * the case this exists to catch slip through.
 *
 * The cost is about a second on each background start, paid once, against
 * the four turns a phantom server cost in a real session.
 */
const BACKGROUND_SETTLE_MS = 1_200;

async function startBackground(command: string, cwd: string): Promise<ToolResult> {
  const host = shellHost();
  const id = `job_${++jobCounter}`;
  const child = spawn(host.file, host.args(command), {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, ONFLIP: "1" },
  });
  const job: BackgroundJob = {
    id,
    command,
    child,
    output: [],
    exitCode: null,
    startedAt: Date.now(),
    cursor: 0,
  };
  const capture = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line !== "") job.output.push(line);
    }
    // Keep memory bounded for long-lived watchers. The cursor shifts by the
    // same amount so the next read still resumes where the last one stopped.
    if (job.output.length > 5_000) {
      const dropped = job.output.length - 5_000;
      job.output.splice(0, dropped);
      job.cursor = Math.max(0, job.cursor - dropped);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("close", (code) => {
    job.exitCode = code ?? 0;
  });
  child.on("error", (e) => {
    job.output.push(`Failed to start: ${e.message}`);
    job.exitCode = 127;
  });
  jobs.set(id, job);

  // "Started in the background" used to be said the instant `spawn` returned,
  // which is before the child can possibly have failed. Live, on a machine
  // with no `python` on PATH, `python -m http.server 8000` was reported as
  // started; the agent then spent four turns and several rewrites hunting a
  // server that had never existed, because every check it ran was right and
  // the only wrong thing it had been told was this line.
  //
  // So the claim is now checked before it is made. A command still running
  // after the settle window is reported as started, exactly as before.
  await new Promise<void>((resolve) => {
    if (job.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, BACKGROUND_SETTLE_MS);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (job.exitCode !== null) {
    jobs.delete(id);
    const detail = job.output.join("\n").trim();
    // Exiting 0 straight away is not a failure — it is a command that simply
    // was not long-running, and saying "started in the background" about it
    // would be just as untrue as the failure case.
    if (job.exitCode === 0) {
      return ok(
        `The command finished immediately rather than staying in the background.\n${detail || "(no output)"}`,
        { title: `${command} (finished)` }
      );
    }
    const how =
      job.exitCode === 127
        ? "it could not be started at all"
        : `it exited immediately with code ${job.exitCode}`;
    return err(
      `The background command did not stay running — ${how}.\n` +
        (detail ? `${detail}\n` : "") +
        "Nothing is listening, so do not check it as though it were. Fix the command, or run it in the foreground to see the whole error."
    );
  }

  return ok(
    `Started in the background as ${id}. Read its output with the \`job_output\` tool (id: "${id}").`,
    { title: `${command} (background)` }
  );
}

export const jobOutputTool: ToolDefinition = {
  name: "job_output",
  description:
    "Read new output from a background command started by `bash` with background: true. Returns only lines emitted since the previous read.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job id returned by the background bash call" },
      kill: { type: "boolean", description: "Terminate the job after reading its output" },
    },
    required: ["id"],
  },
  async run(args) {
    const id = String(args.id ?? "");
    const job = jobs.get(id);
    if (!job) {
      const known = [...jobs.keys()];
      return err(
        `No such job: ${id}.${known.length ? ` Known jobs: ${known.join(", ")}` : " No background jobs are running."}`
      );
    }
    const fresh = job.output.slice(job.cursor);
    job.cursor = job.output.length;

    if (asBool(args.kill) && job.exitCode === null) {
      killProcessTree(job.child, true);
      job.exitCode = job.exitCode ?? -1;
    }

    const status =
      job.exitCode === null
        ? `running for ${Math.round((Date.now() - job.startedAt) / 1000)}s`
        : `exited with code ${job.exitCode}`;
    const body = fresh.length ? clip(fresh.join("\n"), MAX_OUTPUT_LINES) : "(no new output)";
    return ok(`[${id}: ${status}]\n${body}`, {
      title: `${job.command} — ${status}`,
      display: { kind: "text", lines: fresh },
    });
  },
};

/**
 * Stop a background job the agent started. The whole process tree goes —
 * a dev server's child watchers must not outlive it — and the job's final
 * output stays readable through `job_output` until the session ends.
 */
export const killJobTool: ToolDefinition = {
  name: "kill_job",
  description:
    "Stop a background command started by `bash` with background: true. Kills the whole process tree. The job's collected output remains readable with job_output.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job id returned by the background bash call" },
    },
    required: ["id"],
  },
  async run(args) {
    const id = String(args.id ?? "").trim();
    const job = jobs.get(id);
    if (!job) {
      const known = [...jobs.keys()].join(", ") || "none";
      return err(`No job with id "${id}". Known jobs: ${known}`);
    }
    if (job.exitCode !== null) {
      return { output: `Job ${id} already exited with code ${job.exitCode}.`, title: id };
    }
    try {
      killProcessTree(job.child);
      return { output: `Stopped job ${id} (${job.command}).`, title: id };
    } catch (e) {
      return err(`Could not stop job ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const SHELL_TOOLS: ToolDefinition[] = [bashTool, jobOutputTool, killJobTool];
