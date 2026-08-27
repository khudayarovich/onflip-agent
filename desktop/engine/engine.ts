import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  loadConfig,
  saveConfig,
  clearConfigKeys,
  firstPositiveInt,
  OnFlipConfig,
} from "onflip/dist/config";
import {
  allModels,
  normalizeModel,
  defaultModel,
  isThinkingLevel,
  cacheModels,
  ThinkingLevel,
} from "onflip/dist/models";
import { resolveAuth, ResolvedAuth } from "onflip/dist/auth/resolve";
import { spawnExtractToken, takeExtractError } from "onflip/dist/auth/extract";
import { fetchAccessToken } from "onflip/dist/auth/access";
import { chooseTransport, Transport } from "onflip/dist/chatgpt/transport";
import { discoverModels } from "onflip/dist/chatgpt/models-api";
import {
  configureBrowser,
  closeBrowser,
  clearBrowserProfile,
  openConversation,
  checkSignedIn,
  setActiveProject,
  listConversations,
  listProjectConversations,
  listProjects,
  createProject,
  takeComposerWarning,
  queueAttachments,
  takeReplyImages,
  takeProjectWarning,
  currentConversationId,
  pageSessionUser,
  deleteConversations,
  RemoteProject,
} from "onflip/dist/chatgpt/browser-client";
import { setBrowserFrameSink, BrowserFrame } from "onflip/dist/tools/browser";
import { recordSend, usageSummary, associateAccount, UNKNOWN_ACCOUNT } from "./usage";
import {
  createToolRegistry,
  createSessionState,
  killAllJobs,
  resetShellCwd,
  getShellCwd,
} from "onflip/dist/tools";
import { buildSystemPrompt } from "onflip/dist/agent/system";
import { loadProjectContext, ProjectContext } from "onflip/dist/agent/context";
import { newMessage } from "onflip/dist/agent/protocol";
import { runTurn, compactNow, AgentOptions } from "onflip/dist/agent/run";
import {
  ApprovalMode,
  isApprovalMode,
  createPolicy,
  evaluate,
  remember,
  commandKey,
  PolicyState,
  BashRules,
  isRuleAction,
  PermissionRequest,
  PermissionDecision,
} from "onflip/dist/agent/permissions";
import {
  StoredSession,
  createSession,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  latestSession,
  recentProjects,
  deriveTitle,
  snapshotContentsAvailable,
} from "onflip/dist/agent/store";
import { openLog, closeLog, logger } from "onflip/dist/log";
import type { ChatMessage, SessionState, ToolCall, ToolResult, ToolDisplay } from "onflip/dist/types";

import { Peer } from "../shared/wire";
import {
  ApprovalDecisionDTO,
  ApprovalRequestDTO,
  ChatItem,
  ChatProjectDTO,
  ConfigView,
  DisplayPayload,
  EngineStatus,
  ExportResult,
  FileDiff,
  ModelDTO,
  RecentProjectDTO,
  RemoteChatDTO,
  SessionSummaryDTO,
  ToolCallDTO,
  ToolResultDTO,
} from "../shared/protocol";
import { buildFileDiff } from "./diffs";
import { replayItems, stripMentionNote } from "./replay";
import { expandSkillToken } from "../shared/skills";
import { subjectFor } from "./subjects";

export const ENGINE_VERSION = "0.1.0";

/**
 * The desktop engine: the OnFlip core assembled the same way the REPL
 * assembles it, but speaking JSON-RPC to the Electron app instead of drawing
 * a terminal. One engine process owns one working directory, one transport,
 * and one live session at a time — exactly the shape of the CLI.
 */
export class Engine {
  private config = loadConfig();
  private auth!: ResolvedAuth;
  private transport!: Transport;
  private transportReason = "";
  /** Last answer from the sign-in probe, when one has run. */
  private probeSignedIn: boolean | null = null;
  /** Who the ChatGPT session belongs to, once identified. */
  private account: { name?: string; email?: string } | null = null;
  /** User message awaiting proof of delivery — cleared by the first send. */
  private pendingDelivery: string | null = null;
  /** Same message, awaiting the first streamed characters ("read"). */
  private pendingRead: string | null = null;
  private context!: ProjectContext;
  private policy!: PolicyState;
  private session!: StoredSession;
  private toolState: SessionState = createSessionState();
  private history: ChatMessage[] = [];

  private model: string;
  private thinking: ThinkingLevel | undefined;
  private approvalMode: ApprovalMode;
  private shellEnabled: boolean;
  private networkEnabled: boolean;
  private maxIterations: number;

  private abort = new AbortController();
  private busy = false;
  private queue: { text: string; attachments?: string[] }[] = [];
  private connected = false;

  /** Arguments of the call currently awaiting approval, for diff previews. */
  private pendingArgs: Record<string, unknown> | null = null;
  private lastDeltaAt = 0;

  constructor(
    private peer: Peer,
    private cwd: string
  ) {
    const cfg = this.config;
    this.model = normalizeModel(process.env.ONFLIP_MODEL ?? cfg.model) ?? defaultModel();
    const rawThinking = process.env.ONFLIP_THINKING ?? cfg.thinking ?? "";
    this.thinking = isThinkingLevel(rawThinking) ? rawThinking : undefined;
    this.approvalMode = isApprovalMode(cfg.approvalMode ?? "")
      ? (cfg.approvalMode as ApprovalMode)
      : "ask";
    this.shellEnabled = cfg.shell ?? true;
    this.networkEnabled = cfg.network ?? true;
    this.maxIterations = firstPositiveInt(
      [process.env.ONFLIP_MAX_ITERATIONS, cfg.maxIterations],
      40
    );
  }

  // =========================================================================
  // startup
  // =========================================================================

  async init(): Promise<EngineStatus> {
    // A renderer reload calls init again on a live engine; hand back the
    // current state rather than tearing down a working transport.
    if (this.connected) {
      this.pushTranscript();
      const current = this.statusPayload();
      this.peer.emit("status", current);
      this.emitConnect("ready");
      return current;
    }
    this.emitConnect("connecting");
    configureBrowser({
      headed: this.config.headed ?? false,
      persistProfile: this.config.persistProfile ?? true,
    });

    this.auth = await resolveAuth();
    const choice = chooseTransport(this.auth);
    // Counting rides on the transport: one send is one request against the
    // account's limits, whichever code path asked for it.
    const chosen = choice.transport;
    this.transport = {
      name: chosen.name,
      send: async (history, opts) => {
        recordSend(this.accountKey());
        const reply = await chosen.send(history, opts);
        // The first send that comes back proves the user's message reached
        // ChatGPT; the "sending…" badge under it becomes "delivered".
        if (this.pendingDelivery) {
          // A streamed delta may already have advanced the badge to "read".
          // In that case there is no earlier state left to emit.
          if (this.pendingRead) {
            this.peer.emit("delivery", { id: this.pendingDelivery, state: "sent" });
          }
          this.pendingDelivery = null;
          this.pendingRead = null;
        }
        return reply;
      },
      reset: () => chosen.reset(),
      ...(chosen.adopt ? { adopt: (n: number) => chosen.adopt!(n) } : {}),
    };
    this.transportReason = choice.reason;
    // resolveAuth saves the account when the session endpoint answers from
    // Node; the page-context fallback fills it in after the first turn.
    const cfg = loadConfig();
    if (cfg.accountName || cfg.accountEmail) {
      this.account = { name: cfg.accountName, email: cfg.accountEmail };
      associateAccount(this.accountKey());
    }
    setActiveProject(this.currentProject());

    this.context = loadProjectContext(this.cwd);
    this.policy = createPolicy(this.cwd, this.approvalMode, {
      commands: this.config.allowedCommands,
      writeDirs: this.config.allowedWriteDirs,
      bashRules: this.config.bashRules as BashRules | undefined,
    });

    const restored = latestSession(this.cwd);
    if (restored) {
      this.adoptStoredSession(restored);
    } else {
      this.session = createSession(this.cwd, this.model);
      this.history = this.session.messages;
    }

    openLog(this.session.id);
    logger.info("session", "desktop engine started", {
      version: ENGINE_VERSION,
      model: this.model,
      approvalMode: this.approvalMode,
      transport: `${this.transport.name} (${this.transportReason})`,
      cwd: this.cwd,
    });
    this.seedSystemPrompt();
    if (this.session.chatId) await this.reattachChat();

    this.connected = true;
    // Mirror the agent's browser into the desktop panel. The browser itself
    // is a separate OS window that cannot be embedded, so the panel is fed
    // frames captured after each action.
    setBrowserFrameSink((frame: BrowserFrame) => this.peer.emit("browser-frame", frame));
    void this.checkSignInState();
    void this.learnAccountModels();

    this.pushTranscript();
    const status = this.statusPayload();
    this.peer.emit("status", status);
    return status;
  }

  /**
   * Learn the account's real model list, once, on a machine that has never
   * seen it.
   *
   * Slugs are per-account: the web app's name for Luna here is
   * `gpt-5.6-luna-wm`, and the public `gpt-5.6-luna` is not in the list at
   * all. `?model=` with a name ChatGPT does not know is ignored in silence,
   * so a fresh install was quietly running on whatever the web app chose —
   * often a lighter model that then refused the tool protocol, which reads
   * to the user as "this app has no tools". Discovering the list lets the
   * session settle on a slug the account actually has.
   */
  private async learnAccountModels(): Promise<void> {
    if (loadConfig().discoveredModels?.length) return;
    if (!this.transport || this.transport.name !== "browser") return;
    try {
      await this.refreshModels();
      const wanted = defaultModel();
      // Only adopt it when the user has not chosen for themselves.
      const chosen = process.env.ONFLIP_MODEL ?? loadConfig().model;
      if (!chosen && wanted !== this.model) {
        this.model = wanted;
        saveConfig({ model: wanted });
        if (this.session) this.session.model = wanted;
        this.notice(`Using ${wanted}, the model this account reports.`);
      }
      this.pushStatus();
    } catch (e) {
      logger.warn("engine", "could not read the account's model list", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Only the configuration that can be silently signed out needs probing. */
  private async checkSignInState(): Promise<void> {
    if (this.transport.name !== "browser" || this.auth.cookies.length > 0) {
      this.emitConnect("ready");
      return;
    }
    try {
      const state = await checkSignedIn(this.auth.cookies);
      this.probeSignedIn = state.signedIn;
      this.pushStatus();
      if (state.signedIn) {
        this.emitConnect("ready");
        return;
      }
      // Point at the button in this app, not at a terminal command: a
      // desktop user on a fresh machine has no CLI, and when the cookie
      // reader could not run at all, saying "no session found" would blame
      // the account for a missing runtime.
      const why = takeExtractError();
      this.emitConnect(
        "signed-out",
        state.reachable
          ? `OnFlip is not signed in to ChatGPT — open the account menu (bottom left) and choose "Sign in to ChatGPT".${why ? ` (${why})` : ""}`
          : `ChatGPT could not be reached (${state.detail}).`
      );
    } catch (e) {
      this.emitConnect("error", e instanceof Error ? e.message : String(e));
    }
  }

  private emitConnect(state: "connecting" | "ready" | "signed-out" | "error", detail?: string) {
    this.peer.emit("connect", { state, detail });
  }

  private adoptStoredSession(restored: StoredSession): void {
    this.session = restored;
    this.history = restored.messages;
    this.toolState = createSessionState();
    this.toolState.todos = restored.todos ?? [];
    this.toolState.snapshots = restored.snapshots ?? [];
    if (restored.model) this.model = restored.model;
    // What was loaded is what is on disk — a save with nothing new must not
    // bump the session's place in the sidebar.
    this.savedFingerprint = this.fingerprint();
    // The live ChatGPT thread does not survive the process; replay on next send.
    this.transport?.reset();
  }

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
      cwd: this.cwd,
      session: this.toolState,
      signal: this.abort.signal,
      requestPermission: (req) => this.requestPermission(req),
      readOnly: this.approvalMode === "read-only",
      disableShell: !this.shellEnabled,
      disableNetwork: !this.networkEnabled,
      onProgress: (tool, chunk) => {
        if (this.runningToolId) {
          this.peer.emit("tool-progress", { id: this.runningToolId, chunk });
        }
      },
    });
  }

  private async reattachChat(): Promise<boolean> {
    const chatId = this.session.chatId;
    if (!chatId || this.transport.name !== "browser" || !this.transport.adopt) return false;
    try {
      await openConversation(this.auth.cookies, chatId);
      this.transport.adopt(this.history.length);
      return true;
    } catch (e) {
      logger.warn("session", "could not reattach", {
        chatId,
        error: e instanceof Error ? e.message : String(e),
      });
      this.notice(
        "That session's ChatGPT conversation could not be reopened — continuing in a new chat instead."
      );
      this.session.chatId = undefined;
      this.transport.reset();
      return false;
    }
  }

  // =========================================================================
  // status
  // =========================================================================

  statusPayload(): EngineStatus {
    const cfg = loadConfig();
    return {
      version: ENGINE_VERSION,
      cwd: this.cwd,
      home: os.homedir(),
      sessionId: this.session?.id ?? "",
      sessionTitle: this.session ? deriveTitle(this.session) : "",
      chatId: this.session?.chatId,
      model: this.model,
      thinking: this.thinking,
      approvalMode: this.approvalMode,
      shellEnabled: this.shellEnabled,
      networkEnabled: this.networkEnabled,
      maxIterations: this.maxIterations,
      transport: this.transport
        ? `${this.transport.name} (${this.transportReason})`
        : "not connected",
      gitBranch: this.context?.git?.branch,
      gitDirty: this.context?.git?.dirty,
      instructionSources: this.context?.instructionSources ?? [],
      chatProject: this.currentProject()
        ? { id: this.currentProject()!.id, name: this.currentProject()!.name }
        : undefined,
      cooldownUntil: cfg.cooldownUntil && cfg.cooldownUntil > Date.now() ? cfg.cooldownUntil : undefined,
      headed: cfg.headed ?? false,
      busy: this.busy,
      queued: this.queue.map((q) => q.text),
      snapshotCount: this.toolState.snapshots.length,
      todoCount: this.toolState.todos.length,
      signedIn: this.hasSession(),
      account: this.account,
      usage: usageSummary(this.accountKey()),
    };
  }

  /**
   * Does OnFlip hold a session it can actually send with?
   *
   * Credentials in hand — injected cookies or a stored token — or a probe
   * that found the automation profile already logged in. All three go away
   * on sign-out, so the menu flips back to offering a sign-in.
   */
  private hasSession(): boolean {
    if (loadConfig().signedOut) return false;
    if (this.auth?.cookies.length) return true;
    if (loadConfig().sessionToken) return true;
    return this.probeSignedIn === true;
  }

  private accountKey(): string {
    return this.account?.email?.toLowerCase() || UNKNOWN_ACCOUNT;
  }

  private pushStatus(): void {
    this.peer.emit("status", this.statusPayload());
  }

  private pushTranscript(): void {
    this.peer.emit("transcript", { items: replayItems(this.history) });
    this.peer.emit("todos", { items: this.toolState.todos });
  }

  private notice(text: string): void {
    this.peer.emit("item", { type: "notice", id: randomUUID(), text } satisfies ChatItem);
  }

  // =========================================================================
  // permissions
  // =========================================================================

  private async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    const verdict = evaluate(this.policy, req);
    if (verdict.outcome === "allow") return { allow: true, reason: verdict.reason };
    if (verdict.outcome === "deny") return { allow: false, reason: verdict.reason };

    const dto: ApprovalRequestDTO = {
      kind: req.kind,
      tool: req.tool,
      subject: req.subject,
      reason: verdict.reason,
      dangerous: verdict.dangerous,
      detail: req.detail,
      preview: this.buildPreview(req),
      rememberLabel: this.rememberLabel(req),
    };

    let decision: ApprovalDecisionDTO;
    try {
      decision = await this.peer.request<ApprovalDecisionDTO>("approval", dto);
    } catch {
      return { allow: false, reason: "the approval prompt was dismissed" };
    }

    if (decision.allow) {
      if (decision.remember) {
        remember(this.policy, req);
        saveConfig({
          allowedCommands: [...this.policy.allowedCommands],
          allowedWriteDirs: [...this.policy.allowedWriteDirs],
        });
      }
      return { allow: true };
    }
    if (decision.abort) this.abort.abort();
    return {
      allow: false,
      reason:
        "the user declined this action. Acknowledge it, do not retry the same call, and ask how they would like to proceed if unsure.",
    };
  }

  private rememberLabel(req: PermissionRequest): string | undefined {
    if (req.kind === "command") {
      const key = commandKey(req.subject);
      return key ? `Always allow "${key}"` : undefined;
    }
    if (req.kind === "write" && req.targetPath) {
      const dir = path.dirname(path.resolve(req.targetPath));
      const rel = path.relative(this.cwd, dir).replace(/\\/g, "/") || ".";
      return `Always allow writes in ${rel}`;
    }
    return undefined;
  }

  /** Compute the diff a pending write/edit would produce, for the prompt. */
  private buildPreview(req: PermissionRequest): FileDiff | undefined {
    if (req.kind !== "write" || !req.targetPath || !this.pendingArgs) return undefined;
    try {
      const before = fs.existsSync(req.targetPath)
        ? fs.readFileSync(req.targetPath, "utf8")
        : "";
      const after = this.previewAfter(req.tool, before);
      if (after === null || after === before) return undefined;
      return buildFileDiff(req.targetPath, this.cwd, before, after);
    } catch {
      return undefined;
    }
  }

  private previewAfter(tool: string, before: string): string | null {
    const a = this.pendingArgs!;
    const replaceOnce = (text: string, oldStr: string, newStr: string): string | null => {
      const at = text.indexOf(oldStr);
      if (at < 0) return null;
      return text.slice(0, at) + newStr + text.slice(at + oldStr.length);
    };
    if (tool === "write" && typeof a.content === "string") return a.content;
    if (tool === "edit" && typeof a.old_string === "string" && typeof a.new_string === "string") {
      return a.replace_all
        ? before.split(a.old_string).join(a.new_string)
        : replaceOnce(before, a.old_string, a.new_string);
    }
    if (tool === "multi_edit" && Array.isArray(a.edits)) {
      let working = before;
      for (const raw of a.edits) {
        const e = raw as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
        if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
        const next = e.replace_all
          ? working.split(e.old_string).join(e.new_string)
          : replaceOnce(working, e.old_string, e.new_string);
        if (next === null) return null;
        working = next;
      }
      return working;
    }
    return null;
  }

  // =========================================================================
  // running turns
  // =========================================================================

  send(text: string, attachments?: string[]): { queued: boolean } {
    if (!this.connected) throw new Error("The engine is still connecting — try again in a moment.");
    if (this.busy) {
      // A queued message keeps its own attachments: they belong to that
      // message, not to whichever turn happens to run next.
      this.queue.push({ text, attachments });
      this.pushStatus();
      return { queued: true };
    }
    void this.runOneTurn(text, attachments);
    return { queued: false };
  }

  interrupt(): void {
    if (this.busy && !this.abort.signal.aborted) {
      this.abort.abort();
      logger.info("session", "interrupted by user", { queued: this.queue.length });
    }
  }

  clearQueue(): void {
    this.queue = [];
    this.pushStatus();
  }

  private runningToolId: string | null = null;
  private toolIds = new Map<ToolCall, string>();

  private async runOneTurn(text: string, attachments?: string[]): Promise<void> {
    this.busy = true;
    this.abort = new AbortController();
    this.toolIds.clear();
    this.pushStatus();
    this.peer.emit("turn", { state: "start" });

    // @skill tags expand into their full prompt for the model; the emitted
    // item keeps the compact tag, which the chat renders as a link.
    const userMessage = newMessage("user", expandMentions(expandSkillToken(text), this.cwd));
    // Files go to the browser transport as a side-channel: the payload is
    // text, and the composer uploads these alongside it. The model is told
    // in words too, so it knows to look at what was attached.
    if (attachments?.length) {
      queueAttachments(attachments);
      userMessage.content = `${userMessage.content}

[Attached to this message: ${attachments
        .map((f) => path.basename(f))
        .join(", ")}]`;
    }
    // The item carries the history message's id so edit/resend can find it,
    // and delivery events can attach to it.
    this.peer.emit("item", { type: "user", id: userMessage.id, text } satisfies ChatItem);
    logger.info("session", "user turn", { text });
    this.history.push(userMessage);
    this.pendingDelivery = userMessage.id;
    this.pendingRead = userMessage.id;
    // On disk before the turn runs: the sidebar can show the session the
    // moment the question is asked, and a crash mid-turn cannot lose it.
    // Without this a first prompt was invisible for the whole turn, and if
    // the turn never finished it vanished without a trace.
    this.saveNow();

    try {
      // Before anything can open a chat: the project the chat files into.
      await this.ensureOnFlipProject();
      const result = await runTurn(this.history, this.agentOptions());
      if (result.interrupted) {
        this.notice("Interrupted. The work done so far is kept — say what to do next.");
        this.peer.emit("turn", { state: "end", interrupted: true, iterations: result.iterations });
      } else if (result.exhausted) {
        this.peer.emit("turn", {
          state: "end",
          exhausted: true,
          iterations: result.iterations,
          error: `Stopped after ${result.iterations} of ${this.maxIterations} steps without finishing. Say "continue" to keep going, or raise the step budget in Settings.`,
        });
      } else {
        this.peer.emit("turn", { state: "end", iterations: result.iterations });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("session", "turn failed", {
        error: message,
        stack: e instanceof Error ? e.stack : undefined,
      });
      this.peer.emit("item", { type: "error", id: randomUUID(), text: message } satisfies ChatItem);
      this.peer.emit("turn", { state: "end", error: message });
    } finally {
      const composerWarning = takeComposerWarning();
      if (composerWarning) this.notice(composerWarning);

      // Images ChatGPT drew this turn. They live on the page, not on disk,
      // so they are carried into the transcript as data URLs and saved only
      // if the user asks for them.
      for (const image of takeReplyImages()) {
        this.peer.emit("item", {
          type: "image",
          id: randomUUID(),
          dataUrl: image.dataUrl,
          name: image.name,
        } satisfies ChatItem);
      }
      const projectWarning = takeProjectWarning();
      if (projectWarning) this.notice(projectWarning);

      // No send ever succeeded, so the message never reached ChatGPT.
      if (this.pendingDelivery) {
        this.peer.emit("delivery", { id: this.pendingDelivery, state: "failed" });
        this.pendingDelivery = null;
        this.pendingRead = null;
      }

      // Remember which ChatGPT conversation this session is writing into, so
      // deleting the session can delete its conversations too.
      const conversationId = currentConversationId();
      if (conversationId && this.session) {
        const ids = (this.session.chatIds ??= []);
        if (!ids.includes(conversationId)) ids.push(conversationId);
      }

      const next = this.queue.shift();
      // Keep the engine busy across the hand-off. If idle were exposed here,
      // a new send could start beside the queued turn before setImmediate runs.
      this.busy = next !== undefined;
      this.saveNow();
      this.pushStatus();
      this.maybeAdoptChatTitle();
      this.maybeIdentifyAccount();

      if (next !== undefined) {
        // Start synchronously through the point where runOneTurn installs its
        // new AbortController. A stop click can then never hit the old turn's
        // already-finished controller during the queue hand-off.
        void this.runOneTurn(next.text, next.attachments);
      }
    }
  }

  private accountFetchInFlight = false;

  /**
   * Identify the account through the page when the Node-side session read
   * could not — Cloudflare blocks that one for some machines. Runs after a
   * turn, when the browser is already warm, and only until it succeeds.
   */
  private maybeIdentifyAccount(): void {
    if (this.accountFetchInFlight || this.account) return;
    if (!this.transport || this.transport.name !== "browser") return;
    this.accountFetchInFlight = true;
    setTimeout(() => {
      void (async () => {
        try {
          if (this.busy || this.account) return;
          const user = await pageSessionUser(this.auth.cookies);
          if (!user) return;
          this.account = user;
          saveConfig({ accountName: user.name, accountEmail: user.email });
          // Requests counted before the account was known belong to it.
          associateAccount(this.accountKey());
          this.pushStatus();
        } catch {
          // Identification is cosmetic; the session works without it.
        } finally {
          this.accountFetchInFlight = false;
        }
      })();
    }, 2_000);
  }

  private titleFetchInFlight = false;

  /**
   * Adopt ChatGPT's own generated title for the conversation as the session
   * title, so the sidebar shows "Fix the flaky auth test" rather than the raw
   * first prompt line. The title is generated a few seconds after the first
   * reply, so the lookup waits — and it is strictly cosmetic: any failure or
   * a turn starting in the meantime just means trying again after the next
   * turn, since the session is still untitled.
   */
  private maybeAdoptChatTitle(): void {
    if (this.titleFetchInFlight) return;
    if (!this.session || this.session.title) return;
    if (!this.transport || this.transport.name !== "browser") return;
    const conversationId = currentConversationId();
    if (!conversationId) return;
    const sessionId = this.session.id;

    this.titleFetchInFlight = true;
    setTimeout(() => {
      void (async () => {
        try {
          // A running send owns the page; skip rather than contend with it.
          if (this.busy || this.session.id !== sessionId || this.session.title) return;
          const title = await this.lookupConversationTitle(conversationId);
          if (!title) return;
          if (this.busy || this.session.id !== sessionId || this.session.title) return;
          this.session.title = title;
          this.saveNow();
          this.pushStatus();
        } catch {
          // Cosmetic — never let a title lookup disturb the session.
        } finally {
          this.titleFetchInFlight = false;
        }
      })();
    }, 5_000);
  }

  private async lookupConversationTitle(conversationId: string): Promise<string | null> {
    // A chat filed into a project leaves the main listing, so with a project
    // active that listing is the first place to look.
    const project = this.currentProject();
    const listings = project
      ? [
          () => listProjectConversations(this.auth.cookies, project.id),
          () => listConversations(this.auth.cookies),
        ]
      : [() => listConversations(this.auth.cookies)];
    for (const list of listings) {
      const chats = await list().catch(() => []);
      const match = chats.find((c) => c.id === conversationId);
      const title = match?.title.trim();
      // ChatGPT's placeholders, before a real title has been generated.
      if (title && title !== "(untitled chat)" && !/^new chat$/i.test(title)) return title;
    }
    return null;
  }

  private agentOptions(): AgentOptions {
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
        onThinking: (iteration) => this.peer.emit("thinking", { iteration }),
        onDelta: (full) => {
          // The first streamed characters prove ChatGPT received the message
          // and is answering — the "read" stage of the delivery badge.
          if (this.pendingRead) {
            this.peer.emit("delivery", { id: this.pendingRead, state: "read" });
            this.pendingRead = null;
          }
          const now = Date.now();
          if (now - this.lastDeltaAt < 150) return;
          this.lastDeltaAt = now;
          this.peer.emit("delta", { tail: full.slice(-240) });
        },
        onNarration: (narration) => {
          this.peer.emit("item", {
            type: "narration",
            id: randomUUID(),
            text: narration,
          } satisfies ChatItem);
        },
        onToolStart: (call) => {
          const id = randomUUID();
          this.toolIds.set(call, id);
          this.runningToolId = id;
          this.pendingArgs = call.arguments;
          const dto: ToolCallDTO = {
            id,
            tool: call.tool,
            subject: subjectFor(call.tool, call.arguments),
            args: call.arguments,
          };
          this.peer.emit("item", { type: "tool", id, call: dto } satisfies ChatItem);
        },
        onToolEnd: (call, result) => {
          const id = this.toolIds.get(call) ?? randomUUID();
          this.runningToolId = null;
          this.pendingArgs = null;
          this.peer.emit("tool-update", { id, result: this.convertResult(result) });
          if (call.tool.startsWith("todo")) {
            this.peer.emit("todos", { items: this.toolState.todos });
          }
        },
        onNotice: (noticeText) => this.notice(noticeText),
        onFinal: (final) => {
          this.peer.emit("item", {
            type: "assistant",
            id: randomUUID(),
            text: final,
          } satisfies ChatItem);
        },
      },
    };
  }

  private convertResult(result: ToolResult): ToolResultDTO {
    return {
      title: result.title,
      output: result.output.length > 20_000 ? `${result.output.slice(0, 20_000)}\n…` : result.output,
      error: result.error,
      denied: result.denied,
      display: this.convertDisplay(result.display),
    };
  }

  private convertDisplay(display: ToolDisplay | undefined): DisplayPayload {
    if (!display) return { kind: "none" };
    if (display.kind === "text") return { kind: "text", lines: display.lines.slice(0, 400), lang: display.lang };
    if (display.kind === "todos") return { kind: "todos", items: display.items };
    if (display.kind === "diff") {
      return {
        kind: "diff",
        diff: buildFileDiff(display.path, this.cwd, display.oldText, display.newText),
      };
    }
    return { kind: "none" };
  }

  // =========================================================================
  // sessions and projects
  // =========================================================================

  newSession(): EngineStatus {
    this.assertIdle();
    this.saveNow();
    this.session = createSession(this.cwd, this.model);
    this.history = this.session.messages;
    this.toolState = createSessionState();
    this.seedSystemPrompt();
    this.transport.reset();
    this.pushTranscript();
    this.pushStatus();
    return this.statusPayload();
  }

  listSessionSummaries(limit?: number): SessionSummaryDTO[] {
    return listSessions({ limit: limit ?? 30 });
  }

  async resumeSession(id: string): Promise<EngineStatus> {
    this.assertIdle();
    const restored = loadSession(id);
    if (!restored) throw new Error("That session could not be read.");
    this.saveNow();

    // A session belongs to a directory; follow it there if it still exists.
    if (path.resolve(restored.cwd) !== path.resolve(this.cwd) && fs.existsSync(restored.cwd)) {
      this.relocate(restored.cwd);
    }
    this.adoptStoredSession(restored);
    this.seedSystemPrompt();
    if (restored.chatId) await this.reattachChat();
    this.pushTranscript();
    this.pushStatus();
    return this.statusPayload();
  }

  /**
   * Open a visible ChatGPT window on OnFlip's own browser profile so the
   * user can sign in by hand. The running headless browser is closed first —
   * a login window nobody can see helps nobody — and the profile keeps the
   * session afterwards, so one sign-in fixes every future send.
   */
  /**
   * Adopt a session the user just signed into, in the desktop's own sign-in
   * window (see electron/signin.ts).
   *
   * The cookies are written to config the same way `onflip login` writes
   * them, so the CLI and a later restart both pick the session up, and the
   * live transport is pointed at them immediately: the cookie array the
   * transport was constructed with is refilled in place, then the automation
   * browser is closed so the next send relaunches it carrying the new
   * session. Rebuilding the transport instead would strand the conversation
   * this session is attached to.
   */
  async applySignIn(
    cookies: { name: string; value: string }[],
    account?: { name?: string; email?: string }
  ): Promise<{ ok: boolean }> {
    // The session token may arrive whole or split across `.0`/`.1`; anything
    // else in the jar is a session cookie but not *the* one, and picking the
    // first long value would happily store a Cloudflare cookie instead.
    const base = "__Secure-next-auth.session-token";
    const rank = (name: string) =>
      name === base ? 0 : name === `${base}.0` ? 1 : name === `${base}.1` ? 2 : 3;
    const primary = [...cookies]
      .filter((c) => c.value.length >= 20)
      .sort((a, b) => rank(a.name) - rank(b.name) || b.value.length - a.value.length)
      .find((c) => rank(c.name) < 3);
    if (!primary) throw new Error("The sign-in returned no session cookie.");

    saveConfig({
      sessionToken: primary.value,
      sessionCookieName: primary.name,
      sessionDeviceId: cookies.find((c) => c.name === "oai-did")?.value,
      // The whole jar, so a restart restores a chunked token intact.
      sessionCookies: cookies,
      // Signing in lifts the suppression a previous sign-out put in place.
      signedOut: false,
    });

    if (this.auth) {
      this.auth.cookies.length = 0;
      this.auth.cookies.push(...cookies);
      this.auth.sessionToken = primary.value;
    }
    this.transport?.reset();
    await closeBrowser().catch(() => {});

    // The window path knows who signed in; the cookie-import path does not,
    // and waiting for the automation browser to be asked after a turn left
    // the panel saying "ChatGPT account" over a working session. The same
    // endpoint that issues the access token names the account, so ask it —
    // bounded, because a name is never worth stalling a sign-in for.
    if (!account?.name && !account?.email) {
      account = await Promise.race([
        fetchAccessToken(cookies)
          .then((info) =>
            info.user?.name || info.user?.email
              ? { name: info.user.name, email: info.user.email }
              : undefined
          )
          .catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8_000)),
      ]);
    }
    if (account?.name || account?.email) {
      this.account = account;
      saveConfig({ accountName: account.name, accountEmail: account.email });
      associateAccount(this.accountKey());
    }
    this.probeSignedIn = true;
    this.emitConnect("ready");
    this.notice("Signed in to ChatGPT — the session is saved and ready to use.");
    this.pushStatus();
    return { ok: true };
  }

  /**
   * Sign in by importing a session already open in Chrome, Edge or Firefox.
   *
   * The same reader `onflip login` uses, run on demand rather than at
   * startup — so it works even while the app is signed out, which is
   * exactly when someone reaches for it. What it cannot do is decrypt
   * Chrome-family cookies on current Windows: those use app-bound
   * encryption, and the reader says so rather than pretending the account
   * was not found.
   */
  async importBrowserSession(): Promise<{ ok: boolean; source?: string; reason?: string }> {
    const extracted = spawnExtractToken();
    if (extracted?.cookies.length) {
      await this.applySignIn(extracted.cookies);
      return { ok: true, source: extracted.source };
    }
    return {
      ok: false,
      reason:
        takeExtractError() ??
        "No signed-in ChatGPT session was found in Chrome, Edge or Firefox.",
    };
  }

  /**
   * Sign out: forget the session everywhere it is kept.
   *
   * Three places hold it, and leaving any one of them behind signs the user
   * straight back in — the stored token, the automation browser's persistent
   * profile, and (cleared by the caller, which owns it) the sign-in window's
   * partition.
   */
  async applySignOut(): Promise<{ ok: boolean }> {
    // Only OnFlip's own copies of the session go: the stored token, and the
    // automation profile under ~/.onflip. The user's Chrome, Edge and
    // Firefox profiles are never read or written here — signing out of the
    // app is not signing out of their browser. The flag is what stops the
    // next start from silently importing those cookies again.
    saveConfig({ signedOut: true });
    clearConfigKeys([
      "sessionToken",
      "sessionCookies",
      "sessionCookieName",
      "sessionDeviceId",
      "accessToken",
      "accessTokenExpiry",
      "accountName",
      "accountEmail",
    ]);
    if (this.auth) {
      this.auth.cookies.length = 0;
      this.auth.sessionToken = "";
      this.auth.accessToken = "";
    }
    this.account = null;
    this.probeSignedIn = false;
    this.transport?.reset();
    await clearBrowserProfile().catch(() => {});

    this.emitConnect(
      "signed-out",
      'Signed out of ChatGPT. Use "Sign in to ChatGPT" in the account menu when you want to work again.'
    );
    this.notice("Signed out — the stored session and the browser profile have been cleared.");
    this.pushStatus();
    return { ok: true };
  }

  removeSession(id: string): { ok: boolean } {
    if (this.session?.id === id) throw new Error("That session is currently open.");
    // Read the record before the file goes: it names the conversations this
    // session opened on chatgpt.com, which should not outlive it. Attached
    // chats (`chatId`) are the user's own and are left alone.
    const stored = loadSession(id);
    const ok = deleteSession(id);
    const remote = stored?.chatIds ?? [];
    if (ok && remote.length > 0 && this.transport?.name === "browser") {
      this.deleteRemoteConversations(remote);
    }
    return { ok };
  }

  /**
   * Delete this session's conversations on chatgpt.com, waiting out any
   * running turn first — a send owns the page. Best-effort with a bounded
   * wait; whatever fails is reported so the user can finish by hand.
   */
  private deleteRemoteConversations(ids: string[], attempt = 0): void {
    if (this.busy) {
      if (attempt < 30) setTimeout(() => this.deleteRemoteConversations(ids, attempt + 1), 5_000);
      else this.notice(`Could not delete ${ids.length} linked ChatGPT chat(s) — remove them at chatgpt.com.`);
      return;
    }
    void deleteConversations(this.auth.cookies, ids)
      .then(({ deleted, failed }) => {
        if (deleted.length > 0) {
          this.notice(
            deleted.length === 1
              ? "Also deleted the session's ChatGPT conversation."
              : `Also deleted the session's ${deleted.length} ChatGPT conversations.`
          );
        }
        if (failed.length > 0) {
          this.notice(
            `${failed.length} linked ChatGPT conversation(s) could not be deleted — remove them at chatgpt.com.`
          );
        }
      })
      .catch(() => {
        this.notice("The session's ChatGPT conversations could not be deleted — remove them at chatgpt.com.");
      });
  }

  recentProjectList(): RecentProjectDTO[] {
    return recentProjects(20);
  }

  async openProject(dir: string): Promise<EngineStatus> {
    this.assertIdle();
    const target = resolveDir(this.cwd, dir);
    if (path.resolve(target) === path.resolve(this.cwd)) return this.statusPayload();

    this.saveNow();
    this.relocate(target);
    const restored = latestSession(target);
    if (restored) {
      this.adoptStoredSession(restored);
      this.seedSystemPrompt();
      if (restored.chatId) await this.reattachChat();
    } else {
      this.session = createSession(target, this.model);
      this.history = this.session.messages;
      this.toolState = createSessionState();
      this.seedSystemPrompt();
      this.transport.reset();
    }
    logger.info("session", "opened project", { cwd: target, session: this.session.id });
    this.pushTranscript();
    this.pushStatus();
    return this.statusPayload();
  }

  changeCwd(dir: string): EngineStatus {
    this.assertIdle();
    const target = resolveDir(this.cwd, dir);
    this.relocate(target);
    this.session.cwd = target;
    this.seedSystemPrompt();
    this.notice(`Working directory is now ${target}.`);
    this.pushStatus();
    return this.statusPayload();
  }

  /** Point every piece of directory-dependent state at `target`. */
  private relocate(target: string): void {
    this.cwd = target;
    process.chdir(target);
    resetShellCwd();
    this.context = loadProjectContext(target);
    this.policy = createPolicy(target, this.approvalMode, {
      commands: [...this.policy.allowedCommands],
      writeDirs: [...this.policy.allowedWriteDirs],
      bashRules: this.policy.bashRules,
    });
  }

  // =========================================================================
  // model / settings
  // =========================================================================

  listModelInfos(): ModelDTO[] {
    return allModels();
  }

  async refreshModels(): Promise<ModelDTO[]> {
    const result = await discoverModels(this.auth);
    cacheModels(result.models.map((m) => ({ slug: m.slug, title: m.title, description: m.description })));
    return allModels();
  }

  setModel(slug: string): EngineStatus {
    const normalized = normalizeModel(slug) ?? "auto";
    this.model = normalized;
    saveConfig({ model: normalized });
    this.session.model = normalized;
    this.pushStatus();
    return this.statusPayload();
  }

  setThinking(level: ThinkingLevel | null): EngineStatus {
    this.thinking = level ?? undefined;
    saveConfig({ thinking: level ?? undefined });
    this.pushStatus();
    return this.statusPayload();
  }

  setApproval(mode: ApprovalMode): EngineStatus {
    if (!isApprovalMode(mode)) throw new Error(`Unknown approval mode: ${mode}`);
    this.approvalMode = mode;
    this.policy.mode = mode;
    saveConfig({ approvalMode: mode });
    this.seedSystemPrompt();
    this.pushStatus();
    return this.statusPayload();
  }

  setShell(enabled: boolean): EngineStatus {
    this.shellEnabled = enabled;
    saveConfig({ shell: enabled });
    this.seedSystemPrompt();
    this.pushStatus();
    return this.statusPayload();
  }

  setNetwork(enabled: boolean): EngineStatus {
    this.networkEnabled = enabled;
    saveConfig({ network: enabled });
    this.seedSystemPrompt();
    this.pushStatus();
    return this.statusPayload();
  }

  configView(): ConfigView {
    const cfg = loadConfig();
    const rules = Object.entries(cfg.bashRules ?? {})
      .filter(([, action]) => isRuleAction(String(action)))
      .map(([pattern, action]) => ({ pattern, action: action as ConfigView["rules"][number]["action"] }));
    return {
      headed: cfg.headed ?? false,
      browserHeadless: cfg.browserHeadless ?? false,
      maxIterations: firstPositiveInt([cfg.maxIterations], 40),
      replyTimeout: firstPositiveInt([cfg.replyTimeout], 600),
      compactAfterChars: firstPositiveInt([cfg.compactAfterChars], 60_000),
      rules,
      allowedCommands: cfg.allowedCommands ?? [],
      allowedWriteDirs: cfg.allowedWriteDirs ?? [],
    };
  }

  setConfigValue(key: string, value: unknown): ConfigView {
    const allowed: Record<string, (v: unknown) => Partial<OnFlipConfig>> = {
      headed: (v) => ({ headed: Boolean(v) }),
      browserHeadless: (v) => ({ browserHeadless: Boolean(v) }),
      maxIterations: (v) => ({ maxIterations: firstPositiveInt([v as number], 40) }),
      replyTimeout: (v) => ({ replyTimeout: firstPositiveInt([v as number], 600) }),
      compactAfterChars: (v) => ({ compactAfterChars: firstPositiveInt([v as number], 60_000) }),
      allowedCommands: (v) => ({ allowedCommands: Array.isArray(v) ? v.map(String) : [] }),
      allowedWriteDirs: (v) => ({ allowedWriteDirs: Array.isArray(v) ? v.map(String) : [] }),
    };
    const patch = allowed[key]?.(value);
    if (!patch) throw new Error(`Unknown setting: ${key}`);
    saveConfig(patch);
    this.config = loadConfig();
    if (key === "maxIterations") {
      this.maxIterations = firstPositiveInt([this.config.maxIterations], 40);
    }
    if (key === "headed") {
      configureBrowser({
        headed: this.config.headed ?? false,
        persistProfile: this.config.persistProfile ?? true,
      });
    }
    if (key === "allowedCommands") {
      this.policy.allowedCommands = new Set(this.config.allowedCommands ?? []);
    }
    if (key === "allowedWriteDirs") {
      this.policy.allowedWriteDirs = new Set(
        (this.config.allowedWriteDirs ?? []).map((d) => path.resolve(d))
      );
    }
    this.pushStatus();
    return this.configView();
  }

  setRule(pattern: string, action: string): ConfigView {
    if (!isRuleAction(action)) throw new Error(`Rule action must be allow, ask or deny.`);
    const cfg = loadConfig();
    const rules: BashRules = { ...(cfg.bashRules as BashRules | undefined) };
    // Last match wins, so restating a rule must move it to the end.
    delete rules[pattern];
    rules[pattern] = action;
    saveConfig({ bashRules: rules });
    this.policy.bashRules = rules;
    this.config = loadConfig();
    return this.configView();
  }

  deleteRule(pattern: string): ConfigView {
    const cfg = loadConfig();
    const rules: BashRules = { ...(cfg.bashRules as BashRules | undefined) };
    delete rules[pattern];
    saveConfig({ bashRules: rules });
    this.policy.bashRules = rules;
    this.config = loadConfig();
    return this.configView();
  }

  // =========================================================================
  // transcript operations
  // =========================================================================

  /**
   * Remove a user message — and everything after it — from the conversation,
   * handing the text back for editing or resending.
   *
   * The live ChatGPT thread still holds the removed turns, so the transport is
   * reset: the next send replays the truncated transcript into a fresh
   * conversation, which is the same recovery a resumed session uses. An
   * attached chat link is dropped for the same reason.
   */
  rollbackMessage(messageId: string): { text: string } {
    this.assertIdle();
    const index = this.history.findIndex((m) => m.id === messageId);
    if (index <= 0 || this.history[index].role !== "user") {
      throw new Error("That message can no longer be edited — start a new prompt instead.");
    }
    const text = stripMentionNote(this.history[index].content);
    this.history.length = index;
    this.transport?.reset();
    this.session.chatId = undefined;

    // Truncating to empty must not leave the old contents on disk — but an
    // untouched empty session also must not create a file.
    if (this.history.some((m) => m.role !== "system")) {
      this.savedFingerprint = "";
      this.saveNow();
    } else {
      deleteSession(this.session.id);
      this.savedFingerprint = "";
    }
    this.pushTranscript();
    this.pushStatus();
    return { text };
  }

  async compactTranscript(): Promise<{ ok: boolean }> {
    this.assertIdle();
    this.busy = true;
    this.abort = new AbortController();
    this.pushStatus();
    // Compaction sends a summarisation request and can run for a while;
    // the turn events keep the working indicator up for the duration.
    this.peer.emit("turn", { state: "start" });
    try {
      // Compaction opens a fresh chat, which must be filed like any other.
      await this.ensureOnFlipProject();
      await compactNow(this.history, this.agentOptions());
      this.notice("Transcript compacted into a fresh conversation.");
      this.pushTranscript();
      return { ok: true };
    } finally {
      this.peer.emit("turn", { state: "end" });
      this.busy = false;
      this.saveNow();
      this.pushStatus();
    }
  }

  sessionDiff(): FileDiff[] {
    const unavailableFiles = new Set(
      this.toolState.snapshots
        .filter((snapshot) => !snapshotContentsAvailable(snapshot))
        .map((snapshot) => snapshot.path)
    );
    const byFile = new Map<string, { before: string | null; after: string | null }>();
    for (const s of this.toolState.snapshots) {
      if (unavailableFiles.has(s.path)) continue;
      const existing = byFile.get(s.path);
      if (existing) existing.after = s.after;
      else byFile.set(s.path, { before: s.before, after: s.after });
    }
    const out: FileDiff[] = [];
    for (const [file, { before, after }] of byFile) {
      out.push(buildFileDiff(file, this.cwd, before ?? "", after ?? ""));
    }
    for (const file of unavailableFiles) {
      const rel = path.relative(this.cwd, file).replace(/\\/g, "/") || file;
      out.push({ path: file, rel, added: 0, removed: 0, lines: [], unavailable: true });
    }
    return out;
  }

  undoPreview(): { rel: string; existedBefore: boolean; unavailable?: boolean } | null {
    const snapshot = this.toolState.snapshots[this.toolState.snapshots.length - 1];
    if (!snapshot) return null;
    const rel = path.relative(this.cwd, snapshot.path).replace(/\\/g, "/") || snapshot.path;
    return {
      rel,
      existedBefore: snapshot.before !== null,
      unavailable: !snapshotContentsAvailable(snapshot) || undefined,
    };
  }

  undoLast(): { ok: boolean; message: string } {
    const snapshot = this.toolState.snapshots.pop();
    if (!snapshot) return { ok: false, message: "Nothing to undo." };
    const rel = path.relative(this.cwd, snapshot.path).replace(/\\/g, "/") || snapshot.path;
    if (!snapshotContentsAvailable(snapshot)) {
      this.toolState.snapshots.push(snapshot);
      return {
        ok: false,
        message: `Cannot undo ${rel}: its contents were omitted from the saved session. The file was left unchanged.`,
      };
    }
    try {
      if (snapshot.before === null) fs.rmSync(snapshot.path, { force: true });
      else fs.writeFileSync(snapshot.path, snapshot.before, "utf8");
      // The model still believes its edit stands; tell it otherwise.
      this.history.push(
        newMessage(
          "user",
          `[OnFlip] The user reverted your change to ${rel}. The file is back to its previous contents. Do not reapply it unless asked.`
        )
      );
      this.saveNow();
      this.pushStatus();
      const message = snapshot.before === null ? `Deleted ${rel}.` : `Reverted ${rel}.`;
      this.notice(message);
      return { ok: true, message };
    } catch (e) {
      this.toolState.snapshots.push(snapshot);
      return {
        ok: false,
        message: `Could not revert ${rel}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  exportTranscript(): ExportResult {
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
    return {
      markdown: parts.join("\n"),
      suggestedName: `onflip-${this.session.id}.md`,
    };
  }

  // =========================================================================
  // ChatGPT conversations and projects
  // =========================================================================

  async listChats(scope: "project" | "all", query?: string): Promise<RemoteChatDTO[]> {
    this.requireBrowserTransport("Listing ChatGPT conversations");
    const project = this.currentProject();
    const chats =
      scope === "project" && project
        ? await listProjectConversations(this.auth.cookies, project.id)
        : await listConversations(this.auth.cookies);

    const q = (query ?? "").trim().toLowerCase();
    const matching = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;

    const projectNames = new Map<string, string>();
    if (scope === "all" && matching.some((c) => c.projectId)) {
      try {
        for (const p of await listProjects(this.auth.cookies)) projectNames.set(p.id, p.name);
      } catch {
        /* ids alone are enough to pick from */
      }
    }
    return matching.slice(0, 30).map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt || undefined,
      projectName: c.projectId ? projectNames.get(c.projectId) ?? "in a project" : undefined,
    }));
  }

  async attachChat(id: string, title?: string): Promise<EngineStatus> {
    this.assertIdle();
    this.requireBrowserTransport("Continuing a ChatGPT conversation");
    const messages = await openConversation(this.auth.cookies, id);

    this.saveNow();
    this.session = createSession(this.cwd, this.model);
    this.session.title = title ?? "ChatGPT conversation";
    this.session.chatId = id;
    this.history = this.session.messages;
    this.toolState = createSessionState();
    this.seedSystemPrompt();
    for (const m of messages) this.history.push(newMessage(m.role, m.content));

    // The thread already holds those messages; none are resent — but it has
    // never seen the system prompt, which adopt() includes on the next turn.
    this.transport.adopt!(this.history.length);
    logger.info("session", "continuing chatgpt conversation", { chatId: id, imported: messages.length });

    this.pushTranscript();
    this.notice(
      messages.length
        ? `Continuing "${this.session.title}" — ${messages.length} earlier messages read back. The thread keeps its own context, so nothing is resent. It also keeps the model it was started with.`
        : `Continuing "${this.session.title}". Its messages could not be read back, but the thread keeps its own context on ChatGPT's side.`
    );
    // Persist right away so the attached session shows in the sidebar before
    // its first turn.
    this.saveNow();
    this.pushStatus();
    return this.statusPayload();
  }

  async listChatProjects(): Promise<ChatProjectDTO[]> {
    this.requireBrowserTransport("Listing ChatGPT projects");
    const projects = await listProjects(this.auth.cookies);
    return projects.map((p) => ({ id: p.id, name: p.name }));
  }

  async setChatProject(id: string | null): Promise<EngineStatus> {
    if (id === null) {
      this.applyProject(null);
      return this.statusPayload();
    }
    const projects = await listProjects(this.auth.cookies);
    const found = projects.find((p) => p.id === id);
    if (!found) throw new Error("That project no longer exists on the account.");
    this.applyProject(found);
    return this.statusPayload();
  }

  async createChatProject(name: string): Promise<EngineStatus> {
    this.requireBrowserTransport("Creating a ChatGPT project");
    const project = await createProject(this.auth.cookies, name);
    this.applyProject(project);
    return this.statusPayload();
  }

  private applyProject(project: RemoteProject | null): void {
    setActiveProject(project);
    saveConfig({
      projectId: project?.id,
      projectShortUrl: project?.shortUrl,
      projectName: project?.name,
    });
    this.config = loadConfig();
    this.pushStatus();
  }

  /** Set once the project has been verified this run, so later sends are free. */
  private projectEnsured = false;

  /**
   * Every chat OnFlip opens must land inside a ChatGPT project — never the
   * user's main list. With nothing configured, an existing "OnFlip" project
   * on the account is adopted, or one is created on the spot. Runs before
   * the first send of the process, so even the very first chat is filed;
   * failure is retried on the next turn rather than remembered.
   */
  private async ensureOnFlipProject(): Promise<void> {
    if (this.projectEnsured) return;
    if (!this.transport || this.transport.name !== "browser") {
      this.projectEnsured = true;
      return;
    }
    if (this.currentProject()) {
      this.projectEnsured = true;
      return;
    }
    try {
      const projects = await listProjects(this.auth.cookies).catch(() => [] as RemoteProject[]);
      const existing = projects.find((p) => p.name.trim().toLowerCase() === "onflip") ?? null;
      const project = existing ?? (await createProject(this.auth.cookies, "OnFlip"));
      saveConfig({
        projectId: project.id,
        projectShortUrl: project.shortUrl,
        projectName: project.name,
      });
      setActiveProject(project);
      this.projectEnsured = true;
      this.notice(
        existing
          ? `Linked your existing "${project.name}" ChatGPT project — every OnFlip chat is filed there.`
          : `Created an "OnFlip" project in ChatGPT — every OnFlip chat is filed there.`
      );
      this.pushStatus();
    } catch (e) {
      this.notice(
        `Could not prepare the OnFlip ChatGPT project (${e instanceof Error ? e.message : String(e)}) — this chat may land in your main list. Retrying next turn.`
      );
    }
  }

  private currentProject(): RemoteProject | null {
    const { projectId, projectShortUrl, projectName } = loadConfig();
    if (!projectId || !projectShortUrl) return null;
    return { id: projectId, shortUrl: projectShortUrl, name: projectName ?? projectId };
  }

  private requireBrowserTransport(what: string): void {
    if (!this.transport || this.transport.name !== "browser" || !this.transport.adopt) {
      throw new Error(`${what} needs the browser transport.`);
    }
  }

  // =========================================================================
  // teardown
  // =========================================================================

  private assertIdle(): void {
    if (this.busy) throw new Error("A turn is still running — stop it first.");
  }

  /** What the last write (or load) of the session looked like. */
  private savedFingerprint = "";

  /**
   * Cheap identity of everything a save would persist. Saving is skipped when
   * this is unchanged, because `saveSession` stamps a fresh `updatedAt` on
   * every write — and the sidebar orders by it, so an unconditional save on
   * every session switch made *opening* a session reorder the list.
   */
  private fingerprint(): string {
    const last = this.history[this.history.length - 1];
    return [
      this.session?.id ?? "",
      this.session?.cwd ?? "",
      this.session?.title ?? "",
      this.session?.chatId ?? "",
      this.model,
      this.history.length,
      last?.id ?? "",
      this.session?.chatIds?.length ?? 0,
      this.toolState.snapshots.length,
      JSON.stringify(this.toolState.todos),
    ].join("|");
  }

  private saveNow(): void {
    if (!this.session) return;
    // A session nobody spoke in is not worth a file: persisting it put an
    // "(empty session)" row in the sidebar for every launch and every project
    // switch. A chat attachment counts as content even before the first turn.
    const hasContent =
      this.session.chatId || this.history.some((m) => m.role !== "system");
    if (!hasContent) return;
    const current = this.fingerprint();
    if (current === this.savedFingerprint) return;
    this.session.messages = this.history;
    this.session.todos = this.toolState.todos;
    this.session.snapshots = this.toolState.snapshots;
    this.session.model = this.model;
    saveSession(this.session);
    this.savedFingerprint = current;
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    this.saveNow();
    killAllJobs();
    logger.info("session", "desktop engine ended");
    closeLog();
    await closeBrowser();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveDir(cwd: string, arg: string): string {
  const expanded =
    arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")
      ? path.join(os.homedir(), arg.slice(1))
      : arg;
  const target = path.resolve(cwd, expanded);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`No such directory: ${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${target}`);
  return target;
}

/** Turn `@path/to/file` mentions into an explicit instruction to read them. */
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
