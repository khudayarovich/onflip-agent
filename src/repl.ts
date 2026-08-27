import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import { ChatMessage, SessionState, PermissionRequest, PermissionDecision } from "./types";
import { loadConfig, saveConfig, configDir, firstPositiveInt } from "./config";
import {
  allModels,
  cacheModels,
  modelsRefreshedAt,
  isKnownModel,
  looksLikeSlug,
  THINKING_LEVELS,
  isThinkingLevel,
  normalizeModel,
  describeModel,
  defaultModel,
} from "./models";
import { resolveAuth, ResolvedAuth } from "./auth/resolve";
import { chooseTransport, Transport } from "./chatgpt/transport";
import { discoverModels } from "./chatgpt/models-api";
import {
  closeBrowser,
  configureBrowser,
  takeComposerWarning,
  takeProjectWarning,
  listConversations,
  listProjectConversations,
  openConversation,
  listProjects,
  createProject,
  checkSignedIn,
  setActiveProject,
  RemoteConversation,
  RemoteProject,
} from "./chatgpt/browser-client";
import { createToolRegistry, createSessionState, killAllJobs, resetShellCwd, getShellCwd } from "./tools";
import { buildSystemPrompt } from "./agent/system";
import { loadProjectContext, initTemplate, gitInfo, ProjectContext } from "./agent/context";
import { newMessage } from "./agent/protocol";
import { runTurn, compactNow, AgentOptions } from "./agent/run";
import {
  ApprovalMode,
  APPROVAL_MODES,
  APPROVAL_DESCRIPTIONS,
  isApprovalMode,
  isRuleAction,
  matchBashRule,
  BashRules,
  RULE_ACTIONS,
  createPolicy,
  evaluate,
  remember,
  PolicyState,
} from "./agent/permissions";
import {
  StoredSession,
  createSession,
  saveSession,
  loadSession,
  listSessions,
  latestSession,
  recentProjects,
  relativeTime,
} from "./agent/store";
import { openLog, closeLog, logFile, logger } from "./log";
import { setTheme, THEME_NAMES, theme } from "./ui/theme";
import { Editor, Completion } from "./ui/editor";
import { askPermission, previewFor, select, confirm } from "./ui/prompt";
import { endKeyboardSession, captureWheel } from "./ui/keys";
import * as ui from "./ui/render";
import * as screen from "./ui/screen";
import { renderTextDiff, formatStats } from "./ui/diff";
import { termWidth } from "./ui/ansi";

export const VERSION = "0.2.0";

export interface ReplOptions {
  cwd: string;
  model?: string;
  thinking?: string;
  approvalMode?: ApprovalMode;
  shell?: boolean;
  network?: boolean;
  maxIterations?: number;
  /** Run this task and exit instead of opening the composer. */
  task?: string;
  /** Suppress chrome and print only the final answer. */
  print?: boolean;
  /** Resume a specific session id. */
  resumeId?: string;
  /** Resume the most recent session for this directory. */
  continueLatest?: boolean;
  /**
   * Take over the terminal with the alternate screen buffer instead of
   * appending to scrollback. Defaults on for interactive sessions.
   */
  fullscreen?: boolean;
}

interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  run(rest: string): Promise<void> | void;
}

/**
 * The interactive session.
 *
 * Holds every piece of mutable session state — model, approval policy, tool
 * registry, transcript — and owns the editor/agent handoff. Slash commands
 * mutate this object directly, which is why a few of them rebuild the system
 * prompt and reset the conversation.
 */
export class Repl {
  private config = loadConfig();
  private auth!: ResolvedAuth;
  private transport!: Transport;
  private context!: ProjectContext;
  private policy!: PolicyState;
  private session!: StoredSession;
  private toolState: SessionState = createSessionState();
  private history: ChatMessage[] = [];
  private editor!: Editor;

  private model: string;
  private thinking: string | undefined;
  private approvalMode: ApprovalMode;
  private shellEnabled: boolean;
  private networkEnabled: boolean;
  private maxIterations: number;

  private abort: AbortController = new AbortController();
  private busy = false;
  private exiting = false;
  /** Set when exit was requested while a turn was still running. */
  private exitAfterTurn = false;
  /**
   * Prompts typed while a turn was running. They fire in order as soon as it
   * finishes, so thinking of the next instruction never means waiting for the
   * agent to be idle before typing it.
   */
  private queue: string[] = [];
  private transportReason = "";
  /** The sign-in probe costs a browser launch; once per session is enough. */
  private signInChecked = false;

  constructor(private opts: ReplOptions) {
    const cfg = this.config;
    this.model = normalizeModel(opts.model ?? process.env.ONFLIP_MODEL ?? cfg.model) ?? defaultModel();
    const rawThinking = opts.thinking ?? process.env.ONFLIP_THINKING ?? cfg.thinking ?? "";
    this.thinking = isThinkingLevel(rawThinking) ? rawThinking : undefined;
    this.approvalMode =
      opts.approvalMode ??
      (isApprovalMode(cfg.approvalMode ?? "") ? (cfg.approvalMode as ApprovalMode) : "ask");
    this.shellEnabled = opts.shell ?? cfg.shell ?? true;
    this.networkEnabled = opts.network ?? cfg.network ?? true;
    this.maxIterations = firstPositiveInt(
      [opts.maxIterations, process.env.ONFLIP_MAX_ITERATIONS, cfg.maxIterations],
      40
    );
    setTheme(cfg.theme ?? "opencode");
  }

  // =========================================================================
  // startup
  // =========================================================================

  async start(): Promise<void> {
    configureBrowser({
      headed: this.config.headed ?? false,
      persistProfile: this.config.persistProfile ?? true,
    });

    if (!this.opts.print) ui.startSpinner("connecting to your ChatGPT session");
    try {
      this.auth = await resolveAuth();
    } finally {
      ui.stopSpinner();
    }

    const choice = chooseTransport(this.auth);
    this.transport = choice.transport;
    this.transportReason = choice.reason;
    // Applied before anything can open a chat, or the first turn of a session
    // would land in the main list regardless of the setting.
    setActiveProject(this.currentProject());

    this.context = loadProjectContext(this.opts.cwd);
    this.policy = createPolicy(this.opts.cwd, this.approvalMode, {
      commands: this.config.allowedCommands,
      writeDirs: this.config.allowedWriteDirs,
      bashRules: this.config.bashRules as BashRules | undefined,
    });

    this.restoreOrCreateSession();
    openLog(this.session.id);
    logger.info("session", "started", {
      version: VERSION,
      model: this.model,
      thinking: this.thinking ?? null,
      approvalMode: this.approvalMode,
      shell: this.shellEnabled,
      transport: `${this.transport.name} (${this.transportReason})`,
      cwd: this.opts.cwd,
    });
    this.seedSystemPrompt();
    if (this.session.chatId) {
      if (!this.opts.print) ui.startSpinner("reopening the ChatGPT conversation");
      try {
        await this.reattachChat();
      } finally {
        ui.stopSpinner();
      }
    }

    if (this.opts.task) {
      await this.warnIfSignedOut();
      await this.runOneShot(this.opts.task);
      return;
    }

    // Take the screen only once startup has succeeded — an auth or transport
    // failure above must land in the user's real terminal, where they can
    // still read it after the process exits.
    if (this.opts.fullscreen ?? this.config.fullscreen ?? true) {
      screen.enter();
    }

    // Pinned above the transcript, so the brand and the two settings that
    // change what a keystroke does stay put while output scrolls past.
    this.refreshHeader();

    ui.banner({
      version: VERSION,
      model: `${this.model}${this.thinking ? ` · ${this.thinking}` : ""}`,
      cwd: this.opts.cwd,
      approval: this.approvalMode,
      transport: `${this.transport.name} (${this.transportReason})`,
      sessionId: this.session.id,
      instructionSources: this.context.instructionSources,
    });

    const project = this.currentProject();
    if (project) {
      ui.info(`New chats go into your "${project.name}" ChatGPT project.`);
      ui.blank();
    }

    if (!this.shellEnabled) {
      ui.notice("Shell is disabled — the agent cannot run commands. Enable it with /shell on.");
    }
    // The window is about to appear on its own; better to have said so.
    if (this.config.headed) {
      ui.notice(
        "The automation browser opens a visible window (headed). Hide it with: onflip config headed false"
      );
      ui.blank();
    }
    if (this.history.filter((m) => m.role !== "system").length > 0) {
      ui.info(
        `Resumed session ${this.session.id} with ${this.history.filter((m) => m.role !== "system").length} messages.`
      );
      ui.blank();
    }

    // With no cookies the whole session rests on the persistent profile, and
    // a signed-out profile otherwise looks perfectly healthy right up until
    // the first command fails with something obscure.
    await this.warnIfSignedOut();

    this.startEditor();
  }

  /** Check the profile only in the configuration that can be silently out. */
  private async warnIfSignedOut(): Promise<void> {
    if (this.signInChecked) return;
    this.signInChecked = true;
    if (this.transport.name !== 'browser') return;
    if (this.auth.cookies.length > 0) return;

    if (!this.opts.print) ui.startSpinner('checking your ChatGPT sign-in');
    let state;
    try {
      state = await checkSignedIn(this.auth.cookies);
    } finally {
      ui.stopSpinner();
    }

    if (state.signedIn) return;
    logger.warn('auth', 'browser profile is not signed in', {
      reachable: state.reachable,
      detail: state.detail,
    });
    ui.error(
      state.reachable
        ? "OnFlip's browser profile is not signed in to ChatGPT, so nothing can be sent yet."
        : `ChatGPT could not be reached (${state.detail}).`
    );
    ui.info('Sign in to ChatGPT in your normal browser (Chrome, Edge or Firefox), then run `onflip login` to pick the session up.');
    ui.blank();
  }

  private restoreOrCreateSession(): void {
    let restored: StoredSession | null = null;
    if (this.opts.resumeId) {
      restored = loadSession(this.opts.resumeId);
      if (!restored) ui.error(`No session with id ${this.opts.resumeId}.`);
    } else if (this.opts.continueLatest) {
      restored = latestSession(this.opts.cwd);
      if (!restored) ui.notice("No previous session in this directory — starting a new one.");
    }

    if (restored) {
      this.session = restored;
      this.history = restored.messages;
      this.toolState.todos = restored.todos ?? [];
      this.toolState.snapshots = restored.snapshots ?? [];
      // The live ChatGPT thread does not survive the process, so the restored
      // transcript has to be replayed into a fresh conversation.
      this.transport.reset();
      if (restored.model) this.model = restored.model;
    } else {
      this.session = createSession(this.opts.cwd, this.model);
      this.history = [];
    }
  }

  /** Install (or refresh) the system prompt at the head of the transcript. */
  private seedSystemPrompt(): void {
    const registry = this.buildTools();
    const prompt = buildSystemPrompt({
      tools: registry.list,
      context: this.context,
      approvalMode: this.approvalMode,
      shellEnabled: this.shellEnabled && this.approvalMode !== "read-only",
    });
    if (this.history[0]?.role === "system") this.history[0].content = prompt;
    else this.history.unshift(newMessage("system", prompt));
  }

  private buildTools() {
    return createToolRegistry({
      cwd: this.opts.cwd,
      session: this.toolState,
      signal: this.abort.signal,
      requestPermission: (req) => this.requestPermission(req),
      readOnly: this.approvalMode === "read-only",
      disableShell: !this.shellEnabled,
      disableNetwork: !this.networkEnabled,
      onProgress: (_tool, chunk) => ui.updateSpinner(chunk),
    });
  }

  // =========================================================================
  // permissions
  // =========================================================================

  private async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    const verdict = evaluate(this.policy, req);

    if (verdict.outcome === "allow") return { allow: true, reason: verdict.reason };
    if (verdict.outcome === "deny") return { allow: false, reason: verdict.reason };

    // Non-interactive runs cannot ask, so they decline rather than guess.
    if (this.opts.print) {
      return {
        allow: false,
        reason:
          "running non-interactively, so approval could not be requested. Re-run with --approve full-auto to allow this automatically.",
      };
    }

    ui.stopSpinner();
    const decision = await askPermission(req, {
      reason: verdict.reason,
      dangerous: verdict.dangerous,
      preview: previewFor(req, this.pendingWritePreview(req)),
    });
    // The tool is about to do its actual work, so put the progress indicator
    // back — a long command otherwise looks like a hang after approval.
    if (decision.allow) ui.startSpinner(req.tool);

    if (decision.allow && decision.remember) {
      remember(this.policy, req);
      this.persistApprovals();
    }
    if (!decision.allow && (decision as { abort?: boolean }).abort) {
      this.abort.abort();
    }
    return decision;
  }

  /**
   * Best-effort new-content lookup so a write can be previewed as a diff.
   * Only `write` carries full content in its arguments; `edit` computes its
   * result internally, so it shows a summary line instead.
   */
  private pendingWritePreview(req: PermissionRequest): string | undefined {
    return req.tool === "write" ? this.lastWriteContent : undefined;
  }

  private lastWriteContent: string | undefined;

  private persistApprovals(): void {
    saveConfig({
      allowedCommands: [...this.policy.allowedCommands],
      allowedWriteDirs: [...this.policy.allowedWriteDirs],
    });
  }

  // =========================================================================
  // running a turn
  // =========================================================================

  private agentOptions(): AgentOptions {
    // In --print mode stdout carries the answer and nothing else, so the run
    // is traced on stderr instead. That keeps `onflip -p … | jq` usable while
    // still showing progress to anyone watching the terminal.
    if (this.opts.print) return this.printModeOptions();

    return {
      transport: this.transport,
      tools: this.buildTools(),
      session: this.toolState,
      model: this.model,
      thinking: this.thinking,
      maxIterations: this.maxIterations,
      shellEnabled: this.shellEnabled && this.approvalMode !== "read-only",
      signal: this.abort.signal,
      compactAfterMessages: this.config.compactAfter ?? 60,
      compactAfterChars: this.config.compactAfterChars ?? 60_000,
      events: {
        onThinking: (iteration) => {
          ui.startSpinner(iteration === 1 ? "thinking" : `thinking (step ${iteration})`);
        },
        onDelta: (full) => {
          const tail = full.slice(-60).replace(/\s+/g, " ");
          ui.updateSpinner(tail);
        },
        onNarration: (text) => {
          ui.stopSpinner();
          ui.narration(text);
        },
        onToolStart: (call) => {
          ui.stopSpinner();
          // Cache write content so the approval prompt can render a diff.
          this.lastWriteContent =
            call.tool === "write" && typeof call.arguments.content === "string"
              ? call.arguments.content
              : undefined;
          ui.toolStart(call);
          ui.startSpinner(call.tool);
        },
        onToolEnd: (call, result) => {
          ui.stopSpinner();
          ui.toolEnd(call, result);
        },
        onNotice: (text) => {
          ui.stopSpinner();
          ui.notice(text);
        },
        onFinal: (text) => {
          ui.stopSpinner();
          ui.assistantMessage(text);
        },
      },
    };
  }

  /** Event wiring for --print: a terse stderr trace, nothing on stdout. */
  private printModeOptions(): AgentOptions {
    const trace = (line: string) => process.stderr.write(`${line}\n`);
    return {
      transport: this.transport,
      tools: this.buildTools(),
      session: this.toolState,
      model: this.model,
      thinking: this.thinking,
      maxIterations: this.maxIterations,
      shellEnabled: this.shellEnabled && this.approvalMode !== "read-only",
      signal: this.abort.signal,
      compactAfterMessages: this.config.compactAfter ?? 60,
      compactAfterChars: this.config.compactAfterChars ?? 60_000,
      events: {
        onToolStart: (call) => {
          const args = JSON.stringify(call.arguments);
          trace(`· ${call.tool} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`);
        },
        onToolEnd: (_call, result) => {
          if (result.error) trace(`  ! ${result.output.split("\n")[0]}`);
        },
        onNotice: (text) => trace(`! ${text}`),
      },
    };
  }

  private async runOneShot(task: string): Promise<void> {
    if (!this.opts.print) ui.userMessage(task);
    this.history.push(newMessage("user", task));

    // In print mode stdout is the answer alone, so failures go to stderr and
    // set a non-zero exit code rather than being rendered into the output.
    const reportFailure = (message: string) => {
      if (this.opts.print) process.stderr.write(`onflip: ${message}\n`);
      else ui.error(message);
      process.exitCode = 1;
    };

    try {
      const result = await runTurn(this.history, this.agentOptions());

      if (result.exhausted) {
        reportFailure(
          `stopped after ${result.iterations} steps without finishing — raise the budget with --max-steps`
        );
      } else if (result.interrupted) {
        reportFailure("interrupted");
      } else if (this.opts.print) {
        process.stdout.write(`${result.finalAnswer.trim()}\n`);
      }
      this.saveNow();
    } catch (e) {
      ui.stopSpinner();
      reportFailure(e instanceof Error ? e.message : String(e));
    } finally {
      await this.shutdown();
    }
  }

  private async handleInput(text: string): Promise<void> {
    // A prompt typed mid-turn is queued rather than dropped. Previously this
    // returned, so the message was silently discarded and the composer just
    // seemed to eat it.
    if (this.busy) {
      this.queue.push(text);
      ui.queued(text, this.queue.length);
      this.editor.setBusy(true, this.queue.length);
      return;
    }

    if (text.startsWith("/")) {
      await this.runSlashCommand(text);
      // A command may have changed the model, mode or theme — all of which the
      // footer shows — so repaint rather than relying on resume().
      if (!this.exiting) this.editor.refresh();
      return;
    }

    this.busy = true;
    this.editor?.setBusy(true, this.queue.length);
    this.abort = new AbortController();
    logger.info("session", "user turn", { text });
    ui.userMessage(text);
    this.history.push(newMessage("user", expandMentions(text, this.opts.cwd)));

    try {
      const result = await runTurn(this.history, this.agentOptions());
      if (result.interrupted) {
        ui.stopSpinner();
        ui.notice("Interrupted. The work done so far is kept — say what to do next.");
        ui.blank();
      } else if (result.exhausted) {
        ui.error(
          `Stopped after ${result.iterations} of ${this.maxIterations} steps without finishing. Say "continue" to keep going, or raise the budget with: onflip config maxIterations ${this.maxIterations * 2}`
        );
      }
    } catch (e) {
      ui.stopSpinner();
      logger.error("session", "turn failed", {
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      ui.error(e instanceof Error ? e.message : String(e));
      const where = logFile();
      if (where) ui.info(`Details logged to ${where}`);
    } finally {
      // If the composer mangled the outgoing prompt, say so once — it explains
      // replies that come back malformed for no visible reason.
      const composerWarning = takeComposerWarning();
      if (composerWarning) ui.notice(composerWarning);
      // Same shape: a project that could not be opened changes where the work
      // ended up, so it has to be said rather than quietly worked around.
      const projectWarning = takeProjectWarning();
      if (projectWarning) ui.notice(projectWarning);
      this.busy = false;
      this.saveNow();
      if (this.exitAfterTurn) {
        void this.shutdown();
        return;
      }
      if (this.exiting) return;

      this.editor.setBusy(false, this.queue.length);

      // Drain on a fresh tick rather than recursing, so a long queue cannot
      // build a deep call stack and the composer repaints between turns.
      const next = this.queue.shift();
      if (next !== undefined) {
        this.editor.setBusy(false, this.queue.length);
        setImmediate(() => void this.handleInput(next));
      }
    }
  }

  /**
   * Stop the running turn.
   *
   * The session is kept: the transcript kept whatever already ran, so the next
   * prompt continues from there rather than starting over. Anything queued
   * fires straight afterwards, which is what makes "esc, then say the new
   * thing" work as a redirect.
   */
  private interruptTurn(): void {
    if (!this.busy || this.abort.signal.aborted) return;
    this.abort.abort();
    ui.updateSpinner("interrupting…");
    logger.info("session", "interrupted by user", { queued: this.queue.length });
  }



  // =========================================================================
  // editor
  // =========================================================================

  private startEditor(): void {
    // Without this the wheel does nothing on the alternate screen and the
    // session looks frozen in place, however well the keyboard scrolls it.
    captureWheel((delta) => {
      if (screen.isActive()) screen.scrollBy(delta);
    });

    this.editor = new Editor({
      location: () => {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        const cwd = getShellCwd(this.opts.cwd);
        const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
        const branch = this.context.git?.branch;
        return `${short.replace(/\\/g, "/")}${branch ? ` (${branch})` : ""}`;
      },
      status: () => {
        const bits = [this.model];
        if (this.thinking) bits.push(this.thinking);
        bits.push(this.approvalMode);
        if (!this.shellEnabled) bits.push("no-shell");
        return bits.join(" · ");
      },
      commands: () =>
        this.commands().map<Completion>((c) => ({
          value: c.name,
          description: c.description,
        })),
      onSubmit: (text) => {
        // The composer is never torn down for a turn — it stays live so the
        // next prompt can be typed and queued while the agent works.
        void this.handleInput(text);
      },
      onInterrupt: () => {
        // Esc during a turn stops it. Esc while idle with a queue clears the
        // queue, which is the only other thing it could usefully mean.
        if (this.busy) {
          this.interruptTurn();
          return;
        }
        if (this.queue.length) {
          const dropped = this.queue.length;
          this.queue = [];
          this.editor.setBusy(false, 0);
          ui.notice(`Cleared ${dropped} queued prompt${dropped === 1 ? "" : "s"}.`);
        }
      },
      onExit: () => {
        // Piped stdin reaches EOF the moment the script is consumed, which is
        // usually while the first turn is still in flight. Finishing the turn
        // and then exiting is what the caller meant; tearing it down mid-flight
        // loses the work and the answer.
        if (this.busy) {
          this.exitAfterTurn = true;
          return;
        }
        void this.shutdown();
      },
      onLineMode: () => {
        // Without this the session looks like it is ignoring keystrokes until
        // enter is pressed, with no clue as to why.
        ui.notice(
          "This terminal will not accept raw keyboard input, so OnFlip is reading whole lines: type your message and press enter. Live editing, completion and the pickers are unavailable."
        );
        ui.info(
          "This usually means stdin is not a console — a wrapper script piping input, or running under a tool that captures stdout."
        );
        ui.blank();
      },
    });
    this.editor.start();
  }

  // =========================================================================
  // slash commands
  // =========================================================================

  private commands(): SlashCommand[] {
    const cmds: SlashCommand[] = [
      {
        name: "/help",
        description: "show these commands",
        run: () => {
          ui.commandHelp(
            "Commands",
            this.commands().map((c) => ({
              name: c.name,
              args: c.args,
              description: c.description,
            }))
          );
          ui.commandHelp("Keys", [
            { name: "enter", description: "send" },
            { name: "ctrl+j", description: "newline" },
            { name: "ctrl+c", description: "interrupt a turn, or clear the composer" },
            { name: "ctrl+d", description: "exit" },
            { name: "↑ ↓", description: "input history" },
            { name: "tab", description: "accept or cycle the completion" },
            { name: "@", description: "complete a file path" },
            { name: "shift+↑ ↓", description: "scroll the transcript" },
            { name: "pgup/pgdn", description: "scroll a page" },
            { name: "ctrl+l", description: "jump back to the latest output" },
          ]);
        },
      },
      {
        name: "/new",
        description: "start a fresh session",
        run: () => this.newSession(),
      },
      {
        name: "/clear",
        description: "clear the transcript, keep the session",
        run: () => {
          this.history = [];
          this.toolState.todos = [];
          this.transport.reset();
          this.seedSystemPrompt();
          this.saveNow();
          ui.info("Transcript cleared.");
          ui.blank();
        },
      },
      {
        name: "/compact",
        description: "summarise the transcript to free up context",
        run: async () => {
          ui.startSpinner("compacting");
          try {
            await compactNow(this.history, this.agentOptions());
            ui.stopSpinner();
            ui.success("Context compacted.");
          } catch (e) {
            ui.stopSpinner();
            ui.error(e instanceof Error ? e.message : String(e));
          }
          ui.blank();
        },
      },
      {
        name: "/model",
        args: "[slug]",
        description: "show or switch the model",
        run: (rest) => this.setModel(rest),
      },
      {
        name: "/models",
        args: "[refresh]",
        description: "list models, or re-read them from your account",
        run: (rest) => {
          if (/^(refresh|reload|update)$/i.test(rest.trim())) return this.refreshModels();
          ui.commandHelp(
            "Models",
            allModels().map((m) => ({ name: m.slug, description: m.description || m.label }))
          );
          const at = modelsRefreshedAt();
          ui.info(
            at
              ? `From your account, refreshed ${relativeTime(at)}. Update with /models refresh.`
              : "Built-in defaults. Read your account's real list with /models refresh."
          );
          ui.blank();
        },
      },
      {
        name: "/thinking",
        args: "[off|low|medium|high]",
        description: "show or set reasoning effort",
        run: (rest) => this.setThinking(rest),
      },
      {
        name: "/approve",
        args: `[${APPROVAL_MODES.join("|")}]`,
        description: "show or set the approval mode",
        run: (rest) => this.setApproval(rest),
      },
      {
        name: "/permission",
        args: "[<pattern> allow|ask|deny]",
        description: "per-command shell rules, e.g. /permission \"git *\" allow",
        run: (rest) => this.setPermission(rest),
      },
      {
        name: "/shell",
        args: "[on|off]",
        description: "allow or block shell commands entirely",
        run: (rest) => this.setShell(rest),
      },
      {
        name: "/theme",
        args: "[name]",
        description: "switch the colour theme",
        run: (rest) => this.setThemeCommand(rest),
      },
      {
        name: "/todos",
        description: "show the current task list",
        run: () => {
          if (this.toolState.todos.length === 0) {
            ui.info("No tasks yet.");
          } else {
            ui.blank();
            ui.renderTodos(this.toolState.todos);
          }
          ui.blank();
        },
      },
      {
        name: "/diff",
        description: "show every file this session has changed",
        run: () => this.showDiff(),
      },
      {
        name: "/undo",
        description: "revert the most recent file change",
        run: () => this.undo(),
      },
      {
        name: "/sessions",
        description: "list and resume earlier sessions",
        run: () => this.pickSession(),
      },
      {
        name: "/chats",
        args: "[all] [filter]",
        description: "continue a chat from your project (all: the whole account)",
        run: (rest) => this.pickChat(rest),
      },
      {
        name: "/project",
        args: "[name | new <name> | off]",
        description: "keep new chats inside a ChatGPT project",
        run: (rest) => this.setProject(rest),
      },
      {
        name: "/init",
        description: "write an AGENTS.md describing this project",
        run: () => this.initProject(),
      },
      {
        name: "/tools",
        description: "list the tools the agent can use",
        run: () => {
          const registry = this.buildTools();
          ui.commandHelp(
            "Tools",
            registry.list.map((t) => ({
              name: t.name,
              description: t.description.split(". ")[0],
            }))
          );
        },
      },
      {
        name: "/status",
        description: "show the current configuration",
        run: () => this.showStatus(),
      },
      {
        name: "/open",
        args: "[path]",
        description: "open a project folder (picker when no path)",
        run: (rest) => this.openProject(rest),
      },
      {
        name: "/cwd",
        args: "[path]",
        description: "move within this project, keeping the session",
        run: (rest) => this.changeDirectory(rest),
      },
      {
        name: "/export",
        args: "[file]",
        description: "write the transcript to a Markdown file",
        run: (rest) => this.exportTranscript(rest),
      },
      {
        name: "/exit",
        description: "quit OnFlip",
        run: () => this.shutdown(),
      },
    ];

    // Project-local commands: .onflip/commands/<name>.md becomes /<name>.
    for (const custom of loadCustomCommands(this.opts.cwd)) {
      cmds.push({
        name: `/${custom.name}`,
        description: custom.description,
        run: (rest) => {
          // Awaited by the dispatcher so the composer stays hidden until the
          // agent turn this expands into has finished.
          const body = custom.body.replace(/\$ARGUMENTS|\{\{args\}\}/g, rest.trim());
          return this.handleInput(body);
        },
      });
    }

    return cmds;
  }

  private async runSlashCommand(input: string): Promise<void> {
    const [word, ...restParts] = input.trim().split(/\s+/);
    const rest = restParts.join(" ");
    const name = word.toLowerCase();

    const commands = this.commands();
    let cmd = commands.find((c) => c.name === name);

    if (!cmd) {
      // Accept unambiguous prefixes, e.g. /mod for /model.
      const matches = commands.filter((c) => c.name.startsWith(name));
      if (matches.length === 1) cmd = matches[0];
      else if (matches.length > 1) {
        ui.error(`Ambiguous command ${name} — did you mean ${matches.map((m) => m.name).join(", ")}?`);
        return;
      }
    }

    if (!cmd) {
      ui.error(`Unknown command ${name}. Try /help.`);
      return;
    }

    // Commands that hand off to the agent manage the editor themselves.
    await cmd.run(rest);
    // Refreshed here rather than in each command, so a new one that changes
    // the model, the mode or the directory cannot forget to.
    this.refreshHeader();
  }

  /** Repaint the pinned header from current state. */
  private refreshHeader(): void {
    if (!screen.isActive()) return;
    screen.setHeader(
      ui.headerLines({
        version: VERSION,
        model: `${this.model}${this.thinking ? ` · ${this.thinking}` : ""}`,
        cwd: this.opts.cwd,
        approval: this.approvalMode,
        transport: this.transport.name,
      })
    );
  }

  // -- individual commands --------------------------------------------------

  private newSession(): void {
    this.saveNow();
    this.session = createSession(this.opts.cwd, this.model);
    this.history = [];
    this.toolState = createSessionState();
    this.transport.reset();
    resetShellCwd();
    this.seedSystemPrompt();
    ui.success(`New session ${this.session.id}.`);
    ui.blank();
  }

  private async setModel(rest: string): Promise<void> {
    const arg = rest.trim();
    if (!arg) {
      const picked = await select<string | null>(
        "Model",
        [
          ...allModels().map((m) => ({
            label: m.slug === this.model ? `${m.slug}  (current)` : m.slug,
            hint: m.description || m.label,
            value: m.slug as string | null,
          })),
          { label: "Refresh this list from my account", value: "__refresh__" as string | null },
          { label: "Cancel", value: null },
        ],
        { fallback: null }
      );
      if (picked === "__refresh__") return this.refreshModels();
      if (picked) this.applyModel(picked);
      return;
    }
    const normalized = normalizeModel(arg);
    // Unknown slugs are allowed through — OpenAI ships them faster than this
    // list tracks — but they still have to look like slugs.
    if (!normalized || !looksLikeSlug(normalized)) {
      ui.error(`"${arg}" is not a model slug. Try /model gpt-5-thinking, or /model with no argument to pick one.`);
      return;
    }
    this.applyModel(normalized);
  }

  /** Re-read the account's model list and cache it. */
  private async refreshModels(): Promise<void> {
    ui.startSpinner("reading the model list from your account");
    try {
      const { models, source } = await discoverModels(this.auth);
      cacheModels(models.map((m) => ({ slug: m.slug, title: m.title, description: m.description })));
      ui.stopSpinner();
      ui.success(`Found ${models.length} models on your account (via ${source}).`);
      ui.commandHelp(
        "Models",
        allModels().map((m) => ({ name: m.slug, description: m.description || m.label }))
      );
    } catch (e) {
      ui.stopSpinner();
      ui.error(e instanceof Error ? e.message : String(e));
      ui.info("Any slug can still be used with /model, listed or not.");
      ui.blank();
    }
  }

  private applyModel(slug: string): void {
    if (!isKnownModel(slug)) {
      // Not necessarily wrong — it may simply be newer than the cached list.
      ui.notice(
        `"${slug}" is not in the cached list; sending it anyway. Run /models refresh to re-read what your account offers.`
      );
    }
    this.model = slug;
    this.session.model = slug;
    saveConfig({ model: slug });
    // The model is bound to a ChatGPT conversation, so switching needs a new one.
    this.transport.reset();
    ui.success(`Model set to ${slug} — ${describeModel(slug)}. Starting a fresh conversation.`);
    ui.stateRow("model", `${slug}${this.thinking ? ` · ${this.thinking}` : ""}`);
    ui.blank();
  }

  private setThinking(rest: string): void {
    const arg = rest.trim().toLowerCase();
    if (!arg) {
      ui.info(`thinking: ${this.thinking ?? "default"}  (${THINKING_LEVELS.join(", ")})`);
      ui.blank();
      return;
    }
    if (!isThinkingLevel(arg)) {
      ui.error(`Invalid level "${arg}". Use one of: ${THINKING_LEVELS.join(", ")}`);
      return;
    }
    this.thinking = arg;
    saveConfig({ thinking: arg });
    ui.success(`Reasoning effort set to ${arg}.`);
    ui.stateRow("model", `${this.model} · ${arg}`);
    ui.blank();
  }

  private async setApproval(rest: string): Promise<void> {
    const arg = rest.trim().toLowerCase();
    let mode: ApprovalMode | null = null;

    if (!arg) {
      mode = await select<ApprovalMode | null>(
        "Approval mode",
        [
          ...APPROVAL_MODES.map((m) => ({
            label: m === this.approvalMode ? `${m}  (current)` : m,
            hint: APPROVAL_DESCRIPTIONS[m],
            value: m as ApprovalMode | null,
            danger: m === "yolo",
          })),
          { label: "Cancel", value: null },
        ],
        { fallback: null }
      );
      if (!mode) return;
    } else if (isApprovalMode(arg)) {
      mode = arg;
    } else {
      ui.error(`Invalid mode "${arg}". Use one of: ${APPROVAL_MODES.join(", ")}`);
      return;
    }

    if (mode === "yolo") {
      const sure = await confirm(
        "yolo approves everything, including deletes and force pushes. Are you sure?"
      );
      if (!sure) {
        ui.info("Left unchanged.");
        ui.blank();
        return;
      }
    }

    this.approvalMode = mode;
    this.policy.mode = mode;
    saveConfig({ approvalMode: mode });
    this.seedSystemPrompt();
    this.transport.reset();
    ui.success(`Approval mode: ${mode} — ${APPROVAL_DESCRIPTIONS[mode]}.`);
    ui.stateRow("approval", mode);
    ui.blank();
  }

  /**
   * Show or edit the per-command shell rules.
   *
   * A single allow/ask/deny toggle cannot express "everything asks except git,
   * and never rm", which is the shape people actually want. Patterns support
   * * and ?, and the last matching rule wins so a catch-all can be written
   * first and refined afterwards.
   */
  private setPermission(rest: string): void {
    const rules: BashRules = { ...((this.config.bashRules ?? {}) as BashRules) };
    const arg = rest.trim();

    if (!arg || arg === "list") {
      const entries = Object.entries(rules);
      if (entries.length === 0) {
        ui.info("No shell rules — the approval mode decides every command.");
        ui.info('Add one with: /permission "git *" allow');
      } else {
        ui.commandHelp(
          "Shell rules (last match wins)",
          entries.map(([pattern, action]) => ({ name: pattern, description: String(action) }))
        );
      }
      ui.blank();
      return;
    }

    if (arg === "clear" || arg === "reset") {
      saveConfig({ bashRules: {} });
      this.config = loadConfig();
      this.policy.bashRules = {};
      ui.success("Shell rules cleared — the approval mode decides again.");
      ui.blank();
      return;
    }

    // A quoted pattern keeps its spaces: /permission "git *" allow
    const match = arg.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(\S+)$/);
    if (!match) {
      ui.error('Use: /permission "<pattern>" allow|ask|deny|default   (or list, or clear)');
      return;
    }
    const pattern = (match[1] ?? match[2] ?? match[3]).trim();
    const action = match[4].toLowerCase();

    // Dropping one rule has to be possible without clearing the table, or the
    // only way back from a typo is to rewrite every rule.
    if (action === "default" || action === "unset" || action === "remove") {
      if (!(pattern in rules)) {
        ui.error(`No rule for "${pattern}". /permission lists the ones you have.`);
        return;
      }
      delete rules[pattern];
      saveConfig({ bashRules: rules });
      this.config = loadConfig();
      this.policy.bashRules = rules;
      ui.success(`Removed the rule for "${pattern}" — the approval mode decides it again.`);
      ui.blank();
      return;
    }

    if (!isRuleAction(action)) {
      ui.error(
        `"${action}" is not a rule action. Use one of: ${RULE_ACTIONS.join(", ")} (or default to remove it)`
      );
      return;
    }

    // Reinserting moves the key to the end, which is what "last match wins"
    // needs for a refinement to actually beat an earlier catch-all.
    delete rules[pattern];
    rules[pattern] = action;
    saveConfig({ bashRules: rules });
    this.config = loadConfig();
    this.policy.bashRules = rules;

    ui.success(`Shell rule set: "${pattern}" → ${action}`);
    const example = pattern.replace(/\*/g, "…");
    ui.info(`Commands like ${example} will now ${action === "ask" ? "prompt" : action}.`);
    ui.blank();
  }

  private setShell(rest: string): void {
    const arg = rest.trim().toLowerCase();
    if (!arg) {
      ui.info(`shell: ${this.shellEnabled ? "enabled" : "disabled"}`);
      ui.blank();
      return;
    }
    const on = ["on", "yes", "true", "1", "enable", "enabled"].includes(arg);
    const off = ["off", "no", "false", "0", "disable", "disabled"].includes(arg);
    if (!on && !off) {
      ui.error('Use "/shell on" or "/shell off".');
      return;
    }
    this.shellEnabled = on;
    saveConfig({ shell: on });
    this.seedSystemPrompt();
    this.transport.reset();
    ui.success(
      on
        ? "Shell enabled — the agent can run commands, subject to the approval mode."
        : "Shell disabled — the agent cannot run commands."
    );
    ui.blank();
  }

  private async setThemeCommand(rest: string): Promise<void> {
    const arg = rest.trim().toLowerCase();
    const name =
      arg ||
      (await select<string | null>(
        "Theme",
        [
          ...THEME_NAMES.map((n) => ({
            label: n === theme().name ? `${n}  (current)` : n,
            value: n as string | null,
          })),
          { label: "Cancel", value: null },
        ],
        { fallback: null }
      )) ||
      "";
    if (!name) return;
    if (!setTheme(name)) {
      ui.error(`Unknown theme "${name}". Available: ${THEME_NAMES.join(", ")}`);
      return;
    }
    saveConfig({ theme: name });
    ui.success(`Theme set to ${name}.`);
    ui.blank();
  }

  private showStatus(): void {
    ui.panel("Status", [
      { label: "version", value: VERSION },
      { label: "model", value: `${this.model} — ${describeModel(this.model)}` },
      { label: "thinking", value: this.thinking ?? "default" },
      { label: "approval", value: `${this.approvalMode} — ${APPROVAL_DESCRIPTIONS[this.approvalMode]}` },
      { label: "shell", value: this.shellEnabled ? "enabled" : "disabled" },
      { label: "network", value: this.networkEnabled ? "enabled" : "disabled" },
      { label: "transport", value: `${this.transport.name} (${this.transportReason})` },
      { label: "cwd", value: this.opts.cwd },
      { label: "shell cwd", value: getShellCwd(this.opts.cwd) },
      { label: "session", value: this.session.id },
      { label: "messages", value: String(this.history.filter((m) => m.role !== "system").length) },
      { label: "changes", value: `${this.toolState.snapshots.length} file writes` },
      { label: "context", value: this.context.instructionSources.join(", ") || "none" },
      { label: "config", value: path.join(configDir(), "config.json") },
    ]);
  }

  private showDiff(): void {
    const snapshots = this.toolState.snapshots;
    if (snapshots.length === 0) {
      ui.info("No files changed this session.");
      ui.blank();
      return;
    }

    // Collapse repeated edits to the same file into one net diff.
    const byFile = new Map<string, { before: string | null; after: string | null }>();
    for (const s of snapshots) {
      const existing = byFile.get(s.path);
      if (existing) existing.after = s.after;
      else byFile.set(s.path, { before: s.before, after: s.after });
    }

    ui.blank();
    for (const [file, { before, after }] of byFile) {
      const rel = path.relative(this.opts.cwd, file).replace(/\\/g, "/") || file;
      const { lines, stats } = renderTextDiff(before ?? "", after ?? "", {
        width: termWidth() - 6,
        indent: `  ${chalk.hex(theme().border)("│")} `,
        context: 2,
        maxLines: 30,
      });
      process.stdout.write(`  ${chalk.hex(theme().accent)("▐")} ${chalk.bold(rel)}  ${formatStats(stats)}\n`);
      for (const line of lines) process.stdout.write(`${line}\n`);
      process.stdout.write("\n");
    }
  }

  private async undo(): Promise<void> {
    const snapshot = this.toolState.snapshots.pop();
    if (!snapshot) {
      ui.info("Nothing to undo.");
      ui.blank();
      return;
    }

    const rel = path.relative(this.opts.cwd, snapshot.path).replace(/\\/g, "/") || snapshot.path;
    const sure = await confirm(
      snapshot.before === null
        ? `Delete ${rel}? It did not exist before this session.`
        : `Revert ${rel} to its state before the ${snapshot.tool}?`
    );
    if (!sure) {
      this.toolState.snapshots.push(snapshot);
      ui.info("Left unchanged.");
      ui.blank();
      return;
    }

    try {
      if (snapshot.before === null) fs.rmSync(snapshot.path, { force: true });
      else fs.writeFileSync(snapshot.path, snapshot.before, "utf8");
      ui.success(snapshot.before === null ? `Deleted ${rel}.` : `Reverted ${rel}.`);
      // The model still believes its edit stands; tell it otherwise.
      this.history.push(
        newMessage(
          "user",
          `[OnFlip] The user reverted your change to ${rel}. The file is back to its previous contents. Do not reapply it unless asked.`
        )
      );
    } catch (e) {
      ui.error(`Could not revert ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      this.toolState.snapshots.push(snapshot);
    }
    ui.blank();
  }

  private async pickSession(): Promise<void> {
    const sessions = listSessions({ limit: 12 });
    if (sessions.length === 0) {
      ui.info("No saved sessions yet.");
      ui.blank();
      return;
    }

    const picked = await select<string | null>(
      "Sessions",
      [
        ...sessions.map((s) => ({
          label: s.title || s.id,
          hint: `${relativeTime(s.updatedAt)} · ${s.messageCount} msgs · ${path.basename(s.cwd)}`,
          value: s.id as string | null,
        })),
        { label: "Cancel", value: null },
      ],
      { fallback: null }
    );
    if (!picked) return;

    const restored = loadSession(picked);
    if (!restored) {
      ui.error("That session could not be read.");
      return;
    }

    this.saveNow();
    this.session = restored;
    this.history = restored.messages;
    this.toolState.todos = restored.todos ?? [];
    this.toolState.snapshots = restored.snapshots ?? [];
    this.model = restored.model || this.model;
    this.seedSystemPrompt();
    // A session attached to a ChatGPT thread resumes *into* that thread;
    // resetting would strand it and replay everything into a new one.
    if (restored.chatId) {
      ui.startSpinner("reopening the ChatGPT conversation");
      try {
        await this.reattachChat();
      } finally {
        ui.stopSpinner();
      }
    } else {
      this.transport.reset();
    }
    ui.success(
      `Resumed ${restored.id} — ${restored.messages.filter((m) => m.role !== "system").length} messages.`
    );
    ui.blank();
  }

  /** The project new chats are started in, from config. */
  private currentProject(): RemoteProject | null {
    const { projectId, projectShortUrl, projectName } = this.config;
    if (!projectId || !projectShortUrl) return null;
    return { id: projectId, shortUrl: projectShortUrl, name: projectName ?? projectId };
  }

  private applyProject(project: RemoteProject | null): void {
    setActiveProject(project);
    saveConfig({
      projectId: project?.id,
      projectShortUrl: project?.shortUrl,
      projectName: project?.name,
    });
    this.config = loadConfig();
  }

  /**
   * Choose a ChatGPT project for new chats.
   *
   * Without one, every turn OnFlip starts lands in the main sidebar and buries
   * the user's own conversations — which is the reason this exists. The chat
   * itself is unaffected; only where it is filed changes.
   */
  private async setProject(rest: string): Promise<void> {
    if (this.transport.name !== "browser") {
      ui.error("Projects are a ChatGPT web feature, so this needs the browser transport.");
      ui.blank();
      return;
    }

    const arg = rest.trim();
    const current = this.currentProject();

    if (arg === "off" || arg === "none" || arg === "clear") {
      this.applyProject(null);
      this.transport.reset();
      ui.success("New chats will go to your main ChatGPT list again.");
      ui.blank();
      return;
    }

    if (/^new\s+/i.test(arg) || arg === "new") {
      const name = arg.replace(/^new\s*/i, "").trim() || "OnFlip";
      ui.startSpinner(`creating the "${name}" project`);
      try {
        const project = await createProject(this.auth.cookies, name);
        this.applyProject(project);
        this.transport.reset();
        ui.stopSpinner();
        ui.success(`Created the "${project.name}" project — new chats will go there.`);
        ui.blank();
      } catch (e) {
        ui.stopSpinner();
        logger.warn("session", "could not create project", {
          name,
          error: e instanceof Error ? e.message : String(e),
        });
        ui.error(`Could not create that project: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    let projects: RemoteProject[];
    ui.startSpinner("reading your ChatGPT projects");
    try {
      projects = await listProjects(this.auth.cookies);
    } catch (e) {
      ui.stopSpinner();
      logger.warn("session", "could not list projects", {
        error: e instanceof Error ? e.message : String(e),
      });
      ui.error(`Could not read your projects: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      ui.stopSpinner();
    }

    // A name given outright skips the picker.
    if (arg) {
      const wanted = arg.toLowerCase();
      const match =
        projects.find((p) => p.name.toLowerCase() === wanted) ??
        projects.find((p) => p.id === arg) ??
        projects.find((p) => p.name.toLowerCase().includes(wanted));
      if (!match) {
        ui.error(`No project matching "${arg}". Run /project to see them, or /project new ${arg}.`);
        return;
      }
      this.applyProject(match);
      this.transport.reset();
      ui.success(`New chats will go into "${match.name}".`);
      ui.blank();
      return;
    }

    const picked = await select<string | null>(
      "Start new chats in",
      [
        ...projects.map((p) => ({
          label: p.id === current?.id ? `${p.name}  (current)` : p.name,
          hint: p.id.slice(0, 14),
          value: p.id as string | null,
        })),
        { label: "New project…", value: "__new__" as string | null },
        { label: "No project — the main chat list", value: "__none__" as string | null },
        { label: "Cancel", value: null },
      ],
      { fallback: null }
    );
    if (!picked) return;

    if (picked === "__none__") return this.setProject("off");
    if (picked === "__new__") return this.setProject("new OnFlip");

    const chosen = projects.find((p) => p.id === picked);
    if (!chosen) return;
    this.applyProject(chosen);
    this.transport.reset();
    logger.info("session", "project selected", { id: chosen.id, name: chosen.name });
    ui.success(`New chats will go into "${chosen.name}".`);
    ui.info("Chats already open are unaffected; this applies from the next new one.");
    // A project URL takes no ?model=, so the project's own model wins. Better
    // said once here than discovered as a mystery later.
    ui.notice("A project carries its own model, so /model applies to chats started outside one.");
    ui.blank();
  }

  /**
   * Re-open the ChatGPT thread a restored session was attached to.
   *
   * Without this, resuming such a session would open a *new* thread and replay
   * the transcript into it — leaving the original conversation orphaned and
   * the user with two copies of the same work on chatgpt.com.
   */
  private async reattachChat(): Promise<boolean> {
    const chatId = this.session.chatId;
    if (!chatId || this.transport.name !== "browser" || !this.transport.adopt) return false;
    try {
      await openConversation(this.auth.cookies, chatId);
      this.transport.adopt(this.history.length);
      logger.info("session", "reattached to chatgpt conversation", { chatId });
      return true;
    } catch (e) {
      // A deleted or unreachable thread is not fatal: dropping the link means
      // the next turn opens a fresh chat and replays, which still works.
      logger.warn("session", "could not reattach", {
        chatId,
        error: e instanceof Error ? e.message : String(e),
      });
      ui.notice(
        `That session's ChatGPT conversation could not be reopened — continuing in a new chat instead.`
      );
      this.session.chatId = undefined;
      this.transport.reset();
      return false;
    }
  }

  /**
   * Continue one of the account's own ChatGPT conversations.
   *
   * Distinct from `/sessions`, which lists OnFlip's local transcripts. This
   * attaches to a thread on chatgpt.com — including ones started in the web UI
   * — so the conversation carries on where it was left, with tools available
   * from that point on.
   */
  private async pickChat(rest: string): Promise<void> {
    if (this.transport.name !== "browser" || !this.transport.adopt) {
      ui.error("Continuing a ChatGPT conversation needs the browser transport.");
      ui.info("Force it with ONFLIP_TRANSPORT=browser, then run /chats again.");
      ui.blank();
      return;
    }

    // With a project set, this lists that project's chats and nothing else —
    // the same chats OnFlip has been putting there. Whatever else is on the
    // account is somebody else's business, and `/chats all` reaches it.
    let arg = rest.trim();
    const project = this.currentProject();
    let scope: RemoteProject | null = project;
    if (/^all\b/i.test(arg)) {
      scope = null;
      arg = arg.replace(/^all\s*/i, "").trim();
    }

    let chats: RemoteConversation[];
    ui.startSpinner(
      scope ? `reading the "${scope.name}" project` : "reading your ChatGPT conversations"
    );
    try {
      chats = scope
        ? await listProjectConversations(this.auth.cookies, scope.id)
        : await listConversations(this.auth.cookies);
    } catch (e) {
      ui.stopSpinner();
      logger.warn("session", "could not list conversations", {
        project: scope?.id ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
      ui.error(`Could not read your conversations: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      ui.stopSpinner();
    }

    const query = arg.toLowerCase();
    const matching = query
      ? chats.filter((c) => c.title.toLowerCase().includes(query))
      : chats;

    if (matching.length === 0) {
      const where = scope ? ` in the "${scope.name}" project` : "";
      ui.info(
        query
          ? `No conversation${where} matching "${arg}".`
          : scope
            ? `No conversations${where} yet.`
            : "No ChatGPT conversations found."
      );
      if (scope) ui.info("/chats all lists everything on the account.");
      ui.blank();
      return;
    }

    // Names for the project column, best-effort — a failure here must not
    // stop someone continuing a conversation.
    const projectNames = new Map<string, string>();
    if (!scope && matching.some((c) => c.projectId)) {
      try {
        for (const p of await listProjects(this.auth.cookies)) projectNames.set(p.id, p.name);
      } catch {
        /* the ids alone are enough to pick from */
      }
    }

    const picked = await select<string | null>(
      scope ? `Continue a chat in "${scope.name}"` : "Continue a ChatGPT conversation",
      [
        ...matching.slice(0, 15).map((c) => ({
          label: c.title,
          hint: [
            c.updatedAt ? relativeTime(c.updatedAt) : c.id.slice(0, 8),
            // Worth showing: a chat in a project is one the main sidebar hides,
            // so "where has it gone" has an answer here.
            c.projectId ? projectNames.get(c.projectId) ?? "in a project" : null,
          ]
            .filter(Boolean)
            .join("  ·  "),
          value: c.id as string | null,
        })),
        { label: "Cancel", value: null },
      ],
      { fallback: null }
    );
    if (!picked) {
      logger.info("session", "chat picker cancelled", {});
      return;
    }

    const chosen = matching.find((c) => c.id === picked);
    logger.info("session", "chat picked", { chatId: picked, title: chosen?.title });
    ui.startSpinner("opening the conversation");
    let messages: Awaited<ReturnType<typeof openConversation>>;
    try {
      messages = await openConversation(this.auth.cookies, picked);
    } catch (e) {
      ui.stopSpinner();
      logger.warn("session", "could not open conversation", {
        chatId: picked,
        title: chosen?.title,
        error: e instanceof Error ? e.message : String(e),
      });
      ui.error(`Could not open that conversation: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      ui.stopSpinner();
    }

    // Leaving the current session behind, so keep it.
    this.saveNow();

    this.session = createSession(this.opts.cwd, this.model);
    this.session.title = chosen?.title ?? "ChatGPT conversation";
    this.session.chatId = picked;
    this.history = [];
    this.toolState = createSessionState();
    this.seedSystemPrompt();
    for (const m of messages) this.history.push(newMessage(m.role, m.content));

    // The thread already holds every one of those messages, so none of them is
    // resent — but it has never seen the system prompt, which adopt() arranges
    // to include on the next turn.
    this.transport.adopt(this.history.length);
    logger.info("session", "continuing chatgpt conversation", {
      chatId: picked,
      title: chosen?.title,
      imported: messages.length,
    });

    ui.success(`Continuing "${chosen?.title ?? picked}"`);
    ui.info(
      messages.length
        ? `${messages.length} earlier message${messages.length === 1 ? "" : "s"} read back — the thread keeps its own context, so nothing is resent.`
        : "Its messages could not be read back, but the thread keeps its own context on ChatGPT's side."
    );
    const last = messages[messages.length - 1];
    if (last) {
      const preview = last.content.replace(/\s+/g, " ").slice(0, 96);
      ui.info(`Last ${last.role === "user" ? "message" : "reply"}: ${preview}${last.content.length > 96 ? "…" : ""}`);
    }
    // Worth saying once: the thread was created with a model of its own, and
    // opening it by URL does not carry a `?model=` override.
    ui.notice("This thread keeps the model it was started with; /model applies to new chats.");
    ui.blank();
  }

  private async initProject(): Promise<void> {
    const target = path.join(this.opts.cwd, "AGENTS.md");
    if (fs.existsSync(target)) {
      ui.notice("AGENTS.md already exists — asking the agent to improve it instead.");
      await this.handleInput(
        "Read AGENTS.md and the codebase, then rewrite AGENTS.md so it accurately describes this project: what it is, the build/test/lint commands that actually work, the architecture worth knowing, and the conventions to follow. Keep it concise."
      );
      return;
    }
    fs.writeFileSync(target, initTemplate(this.opts.cwd, gitInfo(this.opts.cwd)), "utf8");
    ui.success("Created AGENTS.md — asking the agent to fill it in.");
    await this.handleInput(
      "I just created a skeleton AGENTS.md. Explore this codebase and rewrite AGENTS.md so it accurately describes the project: what it is, the build/test/lint commands that actually work, the architecture worth knowing, and the conventions to follow. Verify the commands exist before documenting them. Keep it concise."
    );
  }

  /**
   * Move within the current project, keeping the session.
   *
   * Distinct from `/open`, which changes project and therefore starts a new
   * session. Stepping into a subdirectory to run a build should not cost the
   * transcript.
   */
  private changeDirectory(rest: string): void {
    const arg = rest.trim();
    if (!arg) {
      ui.info(`cwd: ${this.opts.cwd}`);
      ui.info(`shell cwd: ${getShellCwd(this.opts.cwd)}`);
      ui.blank();
      return;
    }
    const target = this.resolveDir(arg);
    if (!target) return;
    this.relocate(target);
    ui.success(`Working directory is now ${target}.`);
    ui.blank();
  }

  /**
   * Open a different project.
   *
   * A directory is the natural session boundary — sessions are already stored
   * and resumed per directory — so switching projects saves the current
   * transcript and starts a fresh one rather than carrying a conversation
   * about one codebase into another, where every path in it is wrong.
   */
  private async openProject(rest: string): Promise<void> {
    const arg = rest.trim();
    const target = arg ? this.resolveDir(arg) : await this.pickProject();
    if (!target) return;

    if (path.resolve(target) === path.resolve(this.opts.cwd)) {
      ui.info(`Already in ${target}.`);
      ui.blank();
      return;
    }

    // Keep whatever was said about the old project before leaving it.
    this.saveNow();

    this.relocate(target);
    this.session = createSession(target, this.model);
    this.history = [];
    this.toolState = createSessionState();
    this.seedSystemPrompt();
    this.transport.reset();
    logger.info("session", "opened project", { cwd: target, session: this.session.id });

    this.describeProject(target);
  }

  /** Expand `~`, resolve against the current directory, and check it is real. */
  private resolveDir(arg: string): string | null {
    const expanded =
      arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")
        ? path.join(os.homedir(), arg.slice(1))
        : arg;
    const target = path.resolve(this.opts.cwd, expanded);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      ui.error(`No such directory: ${target}`);
      return null;
    }
    if (!stat.isDirectory()) {
      ui.error(`Not a directory: ${target}`);
      return null;
    }
    return target;
  }

  /**
   * Point every piece of directory-dependent state at `target`.
   *
   * The policy has to be rebuilt because it holds the workspace root that
   * decides which writes count as out-of-scope — and rebuilding it must carry
   * the bash rules across, or changing directory quietly discards the user's
   * deny rules.
   */
  private relocate(target: string): void {
    this.opts.cwd = target;
    process.chdir(target);
    resetShellCwd();
    this.context = loadProjectContext(target);
    this.policy = createPolicy(target, this.approvalMode, {
      commands: [...this.policy.allowedCommands],
      writeDirs: [...this.policy.allowedWriteDirs],
      bashRules: this.policy.bashRules,
    });
    // Sessions are listed and resumed by directory, so a session that moved
    // has to move with it or it is filed under a project it is not about.
    this.session.cwd = target;
    this.seedSystemPrompt();
    this.editor?.refresh();
  }

  private async pickProject(): Promise<string | null> {
    const here = path.resolve(this.opts.cwd);
    const recents = recentProjects().filter((p) => path.resolve(p.cwd) !== here);
    const children = childDirectories(this.opts.cwd);

    if (recents.length === 0 && children.length === 0) {
      ui.info("No other projects to open yet.");
      ui.info("Open one by path: /open ~/code/my-project");
      ui.blank();
      return null;
    }

    const choices = [
      ...recents.map((p) => ({
        label: path.basename(p.cwd) || p.cwd,
        hint: p.exists
          ? `${p.cwd}  ·  ${p.sessions} session${p.sessions === 1 ? "" : "s"}  ·  ${relativeTime(p.updatedAt)}`
          : `${p.cwd}  ·  no longer there`,
        value: (p.exists ? p.cwd : null) as string | null,
        danger: !p.exists,
      })),
      ...children.map((dir) => ({
        label: `${path.basename(dir)}/`,
        hint: "subdirectory of the current project",
        value: dir as string | null,
      })),
      { label: "Cancel", value: null },
    ];

    return select<string | null>("Open project", choices, { fallback: null });
  }

  /** A short card for a newly opened project, so the switch is legible. */
  private describeProject(target: string): void {
    ui.success(`Opened ${path.basename(target) || target}`);
    ui.info(target);

    const bits: string[] = [];
    const git = this.context.git;
    if (git?.branch) bits.push(`branch ${git.branch}`);
    if (this.context.instructionSources.length) {
      bits.push(this.context.instructionSources.join(", "));
    } else {
      bits.push("no AGENTS.md — /init writes one");
    }
    if (bits.length) ui.info(bits.join("  ·  "));

    const earlier = listSessions({ cwd: target });
    if (earlier.length) {
      ui.info(
        `${earlier.length} earlier session${earlier.length === 1 ? "" : "s"} here — /sessions to resume one.`
      );
    }
    ui.blank();
  }

  private exportTranscript(rest: string): void {
    const file = path.resolve(
      this.opts.cwd,
      rest.trim() || `onflip-${this.session.id}.md`
    );
    const parts: string[] = [`# OnFlip session ${this.session.id}`, ""];
    parts.push(`- Started: ${new Date(this.session.createdAt).toISOString()}`);
    parts.push(`- Model: ${this.model}`);
    parts.push(`- Directory: ${this.session.cwd}`, "");

    for (const m of this.history) {
      if (m.role === "system") continue;
      if (m.content.startsWith("<onflip:result")) {
        parts.push("### Tool result", "", "```", m.content.slice(0, 4000), "```", "");
        continue;
      }
      parts.push(m.role === "user" ? "## User" : "## Assistant", "", m.content, "");
    }

    try {
      fs.writeFileSync(file, parts.join("\n"), "utf8");
      ui.success(`Transcript written to ${file}`);
    } catch (e) {
      ui.error(`Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    ui.blank();
  }

  // =========================================================================
  // teardown
  // =========================================================================

  private saveNow(): void {
    // A session nobody spoke in is not worth a file: saving it unconditionally
    // left an "(empty session)" entry in /sessions for every launch that was
    // opened and closed without a prompt. An attached chat counts as content.
    const hasContent =
      this.session.chatId || this.history.some((m) => m.role !== "system");
    if (!hasContent) return;
    this.session.messages = this.history;
    this.session.todos = this.toolState.todos;
    this.session.snapshots = this.toolState.snapshots;
    this.session.model = this.model;
    saveSession(this.session);
  }

  async shutdown(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.abort.abort();
    ui.stopSpinner();
    this.editor?.stop();
    // Hand the terminal back before the parting message, so it lands in the
    // user's real scrollback rather than on a buffer about to be discarded.
    screen.leave();
    this.saveNow();
    killAllJobs();
    logger.info("session", "ended");
    closeLog();
    endKeyboardSession();
    await closeBrowser();
    if (!this.opts.print) {
      ui.info("Session saved. Resume it with `onflip --continue`.");
      ui.blank();
    }
    process.exit(process.exitCode ?? 0);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Turn `@path/to/file` mentions into an explicit instruction, so the model
 * reads the file rather than guessing at what the user meant.
 */
function expandMentions(text: string, cwd: string): string {
  const mentioned = new Set<string>();
  for (const match of text.matchAll(/@([\w./\\-]+)/g)) {
    const candidate = path.resolve(cwd, match[1]);
    if (fs.existsSync(candidate)) mentioned.add(match[1]);
  }
  if (mentioned.size === 0) return text;
  return [
    text,
    "",
    `[The user referenced these paths: ${[...mentioned].join(", ")}. Read them before answering.]`,
  ].join("\n");
}

interface CustomCommand {
  name: string;
  description: string;
  body: string;
}

/** Load project-local prompt commands from .onflip/commands/*.md. */
/**
 * Immediate subdirectories worth offering as projects.
 *
 * Filtered rather than listed wholesale: a monorepo root has a `node_modules`
 * with a thousand entries in it, and offering those as projects to open makes
 * the picker useless.
 */
function childDirectories(cwd: string, limit = 12): string[] {
  const SKIP = new Set([
    "node_modules", "dist", "build", "out", "target", "vendor",
    "coverage", "__pycache__", ".git",
  ]);
  try {
    return fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => path.join(cwd, e.name))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

function loadCustomCommands(cwd: string): CustomCommand[] {
  const dir = path.join(cwd, ".onflip", "commands");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const file of files) {
    try {
      const body = fs.readFileSync(path.join(dir, file), "utf8");
      const first = body.split("\n").find((l) => l.trim()) ?? "";
      out.push({
        name: path.basename(file, ".md"),
        description: first.replace(/^#+\s*/, "").slice(0, 60) || "project command",
        body,
      });
    } catch {
      /* skip unreadable command files */
    }
  }
  return out;
}
