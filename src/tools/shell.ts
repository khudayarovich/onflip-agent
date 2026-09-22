import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition, ToolResult } from "../types";
import { err, ok, denied, asNumber, asBool, clip } from "./util";
import { assessCommand } from "../agent/permissions";
import { spillText } from "../agent/spill";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_LINES = 400;

/**
 * Cap a stream for the transcript, keeping the whole of it on disk.
 *
 * `clip` is a string function and stays one — the browser and web tools use
 * it too and want nothing written anywhere. This is the shell's version of
 * the same cap, and the difference is that a command's output is often the
 * expensive half of a turn: a test suite, a build, a long search. Losing its
 * middle here, at the tool's own boundary, meant losing it before the
 * transcript ever saw it — so nothing later could give it back and the only
 * way to see it again was to pay for the command twice.
 */
function kept(text: string, maxLines: number, label: string): string {
  const capped = clip(text, maxLines);
  if (capped.length >= text.length) return capped;
  const spilled = spillText(text, label);
  if (!spilled) return capped;
  return `${capped}\n[full output: ${spilled.path} — read it rather than running this again]`;
}

/** Marker used to read the shell's final working directory back out. */
const CWD_MARKER = "__ONFLIP_CWD__";

/**
 * The shell the `bash` tool actually runs under.
 *
 * It used to take $SHELL only when that string contained "bash", and fall
 * back to /bin/sh otherwise - so on any machine whose login shell is zsh,
 * which is every macOS install since Catalina, the tool named `bash` ran
 * under /bin/sh: no [[ ]], no arrays, no ${var^^}, different word splitting.
 * The tool description promises bash, and the model writes bash because of
 * it. Reported from a live macOS install.
 *
 * A real bash is looked for by name first; $SHELL is trusted only when it is
 * itself a bash. /bin/sh remains the last resort, because a shell that exists
 * beats a promise that does not.
 */
function posixShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && fromEnv.includes("bash") && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of [
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/bash",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return fromEnv && fs.existsSync(fromEnv) ? fromEnv : "/bin/sh";
}

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
  if (/вЂ|РІР|[ÐÃ][\u0080-\u00bf]/.test(text)) return true;
  // The other direction, and the one that catches PowerShell's own parser
  // errors: those are written before the command runs, so the prelude that
  // switches the console to UTF-8 has not run yet and the text arrives in
  // the OEM codepage. It reaches us as a drift of replacement characters,
  // which left a model unable to read the syntax error it had just made —
  // so it guessed, and guessed again, two minutes at a time.
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  return replacements >= 4 && replacements / Math.max(1, text.length) > 0.02;
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
      //
      // On a line of its own, not after `; `: appended to the command's last
      // line, a trailing `# comment` swallowed the whole probe.
      cwdProbe:
        "\n$__ok = $?; $__rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($__ok) { 0 } else { 1 }" +
        `; Write-Output ("${CWD_MARKER}:" + $__rc + ":" + (Get-Location).Path)`,
    };
  }
  const file = posixShell();
  return {
    name: path.basename(file),
    file,
    args: (command) => ["-c", command],
    // Same shape as the PowerShell probe: keep the command's status, print
    // the directory, then exit with what the command exited with.
    // Same marker shape as Windows so one parser reads both. `exit` is kept
    // here because a POSIX shell has no deferred formatter to lose.
    //
    // On a line of its own. Appended with `; ` to the command's last line it
    // broke the three shapes a last line most often has: a here-document
    // (`EOF; __rc=…` never closes it, so the probe was written into the file
    // and exit 0 reported), a trailing `&` (a syntax error, nothing ran) and
    // a `# comment` (the probe commented out, and a `cd` in it lost).
    cwdProbe: `\n__rc=$?; printf '${CWD_MARKER}:%s:%s\\n' "$__rc" "$PWD"; exit $__rc`,
  };
}

/**
 * Working directory carried across shell calls within one session, so a `cd`
 * behaves the way it does in a real terminal.
 */
let sessionCwd: string | null = null;

/**
 * Split the trailing probe off a command's output.
 *
 * The probe line carries the working directory *and* the command's real exit
 * code — see `cwdProbe`, where the code travels this way because on Windows
 * `exit` would discard PowerShell's pending object output. Both shells emit
 * the same shape, so one parser reads Windows and macOS alike:
 *
 *     __ONFLIP_CWD__:<code>:<path>
 *
 * Pure, because the two platform shapes differ in exactly the way that is
 * easy to get wrong — a Windows path is full of colons and a POSIX one is
 * not — and only one of them can be run from any given machine.
 */
export function parseProbe(stdout: string): {
  stdout: string;
  cwd: string | null;
  code: number | null;
} {
  let cwd: string | null = null;
  let code: number | null = null;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(`${CWD_MARKER}:`);
    if (idx === -1) continue;
    const payload = lines[i].slice(idx + CWD_MARKER.length + 1).trim();
    // Only the *first* colon separates the code from the path: `C:\Users\me`
    // has its own, and splitting on all of them would truncate every Windows
    // directory to its drive letter.
    const split = payload.indexOf(":");
    const rc = split === -1 ? "" : payload.slice(0, split);
    if (/^-?\d+$/.test(rc)) {
      code = Number(rc);
      cwd = payload.slice(split + 1).trim();
    } else {
      // A probe from before the code was added, or a mangled line. The path
      // is still worth having.
      cwd = payload;
    }
    // Output without a trailing newline shares the marker's line, so only the
    // marker goes — dropping the whole line turned `Write-Host -NoNewline
    // hello` into "(no output)".
    if (idx > 0) lines[i] = lines[i].slice(0, idx);
    else lines.splice(i, 1);
    break;
  }
  return { stdout: lines.join("\n"), cwd, code };
}

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

/**
 * The environment a command the agent runs is given.
 *
 * Without `ELECTRON_RUN_AS_NODE`. The desktop app runs the engine under
 * Electron-as-Node when the machine's own Node cannot load the sqlite
 * binding, and the variable is inherited by everything the engine starts:
 * an Electron app the user asked to have built and run would come up as a
 * bare Node process and fail with nothing on screen to say why. OnFlip's own
 * helpers that need it set it explicitly.
 */
export function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ONFLIP: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
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
      env: { ...commandEnv(), TERM: process.env.TERM ?? "dumb" },
    });

    const stdoutCapture = boundedCapture();
    const stderrCapture = boundedCapture();
    let finished = false;
    let timedOut = false;
    let aborted = false;
    let exitGrace: NodeJS.Timeout | null = null;

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
      stdoutCapture.add(text);
      onProgress?.(text);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      stderrCapture.add(text);
      onProgress?.(text);
    });

    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (exitGrace) clearTimeout(exitGrace);
      signal.removeEventListener("abort", onAbort);
      // A grandchild may still hold the pipes open; nothing more is read.
      child.stdout?.destroy();
      child.stderr?.destroy();

      // Pull the trailing probe out of stdout. It carries both the working
      // directory and the command's real exit code — see `cwdProbe`, where
      // the code travels this way because `exit` would discard PowerShell's
      // pending object output.
      const stdout = stdoutCapture.value();
      const stderr = stderrCapture.value();
      const probe = parseProbe(stdout);
      resolve({
        stdout: probe.stdout,
        stderr,
        // The marker is the authority when it arrived: the process itself now
        // exits 0 on Windows whatever the command did. A command that called
        // `exit` itself kills the shell before the probe runs, so there is no
        // marker and the process code is all there is — which is correct.
        code: probe.code ?? code,
        timedOut,
        aborted,
        cwd: probe.cwd,
      });
    };

    child.on("error", (e) => {
      stderrCapture.add(`\nFailed to start ${host.file}: ${e.message}`);
      done(127);
    });
    child.on("close", (code) => done(code));
    // "close" waits for every holder of the pipes, and a process the command
    // started and left running holds them: `Start-Process -NoNewWindow npm
    // run dev`, `start /b`, a daemon that inherited stdout. The shell had
    // exited, the timeout and Stop both killed its tree — and the orphan,
    // reparented out of that tree, kept the turn waiting until it exited on
    // its own, which a server never does. Measured: a 3-second timeout and a
    // Stop pressed at 8 seconds, returning at 25.2 — the moment the
    // grandchild happened to finish. Once the shell itself has exited, the
    // output still in flight gets a moment to land and then the turn moves on.
    child.on("exit", (code) => {
      if (finished || exitGrace) return;
      exitGrace = setTimeout(() => done(code), EXIT_GRACE_MS);
    });
  });
}

/** How long output may keep arriving after the shell itself has exited. */
const EXIT_GRACE_MS = 1_500;

/** Characters kept from each end of a stream; the middle of more is dropped. */
const CAPTURE_END_CHARS = 1_000_000;

/**
 * A stream's output, bounded, keeping its head and its tail.
 *
 * It was one string grown by `+=` for as long as the command wrote, which
 * throws `RangeError: Invalid string length` a little past half a gigabyte —
 * 0.6 seconds of a fast writer, measured — and took the process with it.
 * The transcript only ever shows a clip, so what matters is the start, the
 * end (where the error and the probe marker live) and saying what was cut.
 */
export function boundedCapture(endChars = CAPTURE_END_CHARS): { add(text: string): void; value(): string } {
  let head = "";
  let tail = "";
  let dropped = 0;
  return {
    add(text: string) {
      if (head.length < endChars) {
        const room = endChars - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (!text) return;
      tail += text;
      if (tail.length > 2 * endChars) {
        dropped += tail.length - endChars;
        tail = tail.slice(-endChars);
      }
    },
    value() {
      return dropped
        ? `${head}\n… [${dropped.toLocaleString("en-US")} characters of output were not kept] …\n${tail}`
        : head + tail;
    },
  };
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
    if (stdout) parts.push(kept(stdout, MAX_OUTPUT_LINES, "bash-stdout"));
    if (stderr) {
      parts.push(`[stderr]\n${kept(stderr, Math.floor(MAX_OUTPUT_LINES / 2), "bash-stderr")}`);
    }
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
      timedOut: result.timedOut,
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
 * Sized from the slow case on each platform, because they are an order of
 * magnitude apart. Measured with a missing executable, which is the case this
 * exists to catch:
 *
 *   PowerShell   761ms   (bare startup 125ms — the rest is PATH search and
 *                         building a full CommandNotFoundException record)
 *   /bin/sh       37ms   (bare startup 33ms)
 *
 * A 400ms window let the Windows case slip straight through, which is how
 * this was got wrong the first time. Using the Windows figure everywhere
 * would instead have taxed every background start on macOS and Linux with
 * more than a second of waiting for nothing, thirty times what that shell
 * needs. The Windows budget is the measurement plus room for a loaded
 * machine; the POSIX one is the same idea at its own scale.
 */
const BACKGROUND_SETTLE_MS = process.platform === "win32" ? 1_200 : 250;

/**
 * How long to wait for a background command to prove it is alive.
 *
 * Overridable because the constant above is a *budget*, and a budget makes a
 * bad assertion. The Windows figure is 1.5× a measurement taken on a warm
 * machine, which is ample in production and far too tight on a cold shared CI
 * runner, where the first PowerShell spawn of a job pays for loading the whole
 * runtime. The test that proves a failing command is not reported as started
 * was therefore racing the runner, and lost often enough that commits touching
 * nothing but Markdown came back red.
 *
 * Raising it in a test costs no wall-clock time: the wait resolves as soon as
 * the child closes, so the window is only a ceiling.
 */
function backgroundSettleMs(): number {
  const override = Number(process.env.ONFLIP_BACKGROUND_SETTLE_MS);
  return Number.isFinite(override) && override > 0 ? override : BACKGROUND_SETTLE_MS;
}

async function startBackground(command: string, cwd: string): Promise<ToolResult> {
  const host = shellHost();
  const id = `job_${++jobCounter}`;
  const child = spawn(host.file, host.args(command), {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: commandEnv(),
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
    const timer = setTimeout(resolve, backgroundSettleMs());
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
