import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
  loadConfig,
  saveConfig,
  clearConfigKeys,
  firstPositiveInt,
  configDir,
  OnFlipConfig,
} from "onflip/dist/config";
import {
  allModels,
  normalizeModel,
  defaultModel,
  effectiveModel,
  modelContextTokens,
  isThinkingLevel,
  cacheModels,
  ThinkingLevel,
} from "onflip/dist/models";
import { resolveAuth, ResolvedAuth } from "onflip/dist/auth/resolve";
import { spawnExtractToken, takeExtractError, lastBrowserFindings } from "onflip/dist/auth/extract";
import { fetchAccessToken } from "onflip/dist/auth/access";
// Through the provider seam: one `if` decides which service's transport is
// built, and ChatGPT's branch is the same call it has always been.
import { chooseTransport, Transport } from "onflip/dist/providers/transport";
import { discoverModels } from "onflip/dist/chatgpt/models-api";
import {
  compactionBudget,
  DEEPSEEK_CEILING_CHARS,
  describePlan,
  planLimitCard,
  promptCrowdsPlan,
  rationedPlan,
} from "onflip/dist/chatgpt/plans";
import { activeProvider, providerLabel } from "onflip/dist/providers/id";
import { attachmentsBlockedReason, uploadsAvailable } from "onflip/dist/chatgpt/transport";
import {
  configureBrowser,
  closeBrowser,
  clearBrowserProfile,
  openConversation,
  checkSignedIn,
  signInWithRealBrowser,
  finishRealBrowserSignIn,
  cancelRealBrowserSignIn,
  pickSignInBrowser,
  setActiveProject,
  listConversations,
  listProjectConversations,
  listProjects,
  createProject,
  fetchAccountPlan,
  takeComposerWarning,
  queueAttachments,
  takeReplyImages,
  takeProjectWarning,
  currentConversationId,
  openedConversationIds,
  sweepConversationsIntoProject,
  pageSessionUser,
  deleteConversations,
  checkSelectorsLive,
  RemoteProject,
  // Through the provider seam rather than naming ChatGPT directly. Today it
  // re-exports exactly these functions unchanged; a second provider makes it
  // a dispatcher without this list moving.
} from "onflip/dist/providers";
import {
  setBrowserFrameSink,
  setBrowserViewport,
  dispatchBrowserInput,
  BrowserFrame,
  BrowserUserInput,
} from "onflip/dist/tools/browser";
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
import { runTurn, compactNow, reducibleChars, AgentOptions } from "onflip/dist/agent/run";
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
  isPlaceholderTitle,
  snapshotContentsAvailable,
} from "onflip/dist/agent/store";
import { openLog, closeLog, logger, logFile } from "onflip/dist/log";
import { isResumableFailure, cooldownRemainingMs, failureCodeOf } from "onflip/dist/chatgpt/backoff";
import { runDoctor, runDeepDoctor, type DoctorReport } from "onflip/dist/chatgpt/doctor";
import { lastBrowserReport } from "onflip/dist/auth/session";
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
import { buildFileDiff, FULL_MAX_CHARS, FULL_MAX_LINES } from "./diffs";
import { replayItems, stripMentionNote } from "./replay";
import { expandSkillToken } from "../shared/skills";
import { subjectFor } from "./subjects";
import { SilenceWatch } from "./silence";

/** What a turn is resumed with, and what a person types by hand today. */
const RESUME_PROMPT = "continue";

/**
 * How long a turn may go completely silent before OnFlip says so.
 *
 * Silent means nothing at all: no reply text, no tool starting or
 * finishing, no output from one that is running. A long build is not
 * silent — it streams — and a model thinking hard still ends up saying
 * something. Two and a half minutes of nothing is not slow, it is stuck.
 */
const SILENCE_WARN_MS = 150_000;

/**
 * And how long before OnFlip stops waiting and starts the work again.
 *
 * Deliberately later than the transport's own stalled-stream check, which
 * fires at 240s and handles the shapes it can recognise. This is the
 * backstop for the shapes it cannot: a turn that hangs with the page
 * looking idle, where nothing throws, nothing times out, and the session
 * sits on "Working" until somebody comes back to the desk. Restarting is
 * the same move the user makes by hand — abandon the wedged conversation,
 * carry the transcript into a fresh one.
 */
const SILENCE_RESUME_MS = 420_000;

/** Consecutive unattended resumes before OnFlip stops and says so. */
const MAX_AUTO_RESUMES = 3;

/**
 * The app's version, read from the package it ships in.
 *
 * It was a hand-written constant, so it still said 0.1.0 six releases later
 * — in the About panel, the status line and every log header. A number that
 * has to be remembered is a number that goes stale.
 */
function readVersion(): string {
  for (const candidate of [
    path.join(__dirname, "..", "..", "package.json"),
    path.join(__dirname, "..", "..", "..", "package.json"),
  ]) {
    try {
      // A leading byte-order mark is invalid JSON and a normal thing to find
      // in a file some Windows tool has rewritten. Losing the version over
      // one is not worth it.
      const raw = fs.readFileSync(candidate, "utf8").replace(/^﻿/, "");
      const pkg = JSON.parse(raw) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      /* try the next location */
    }
  }
  return "0.0.0";
}

export const ENGINE_VERSION = readVersion();

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
  /** Compacted-away messages, kept for display only. Never sent. */
  private archived: ChatMessage[] = [];

  private model: string;
  private thinking: ThinkingLevel | undefined;
  private approvalMode: ApprovalMode;
  private shellEnabled: boolean;
  private networkEnabled: boolean;
  private maxIterations: number;

  private abort = new AbortController();
  private busy = false;
  /** `auto` marks a turn OnFlip queued for itself, which stop may cancel. */
  private queue: { id: string; text: string; attachments?: string[]; auto?: boolean }[] = [];
  private connected = false;

  /** Arguments of the call currently awaiting approval, for diff previews. */
  private pendingArgs: Record<string, unknown> | null = null;
  private lastDeltaAt = 0;

  /** Approvals are the one silence that is the user's, not the model's. */
  private awaitingApproval = 0;

  /**
   * Watches the running turn for the silence that means it has stopped.
   *
   * Every layer below has a timeout and each covers the failure it can see:
   * a send that is refused, a stream that dies mid-answer, a command that
   * never exits. None of them catches the turn that simply stops — tool
   * finished, result delivered, then nothing, with the page looking idle
   * and no error to raise. Reported from a session sat on "Working — step
   * 7" with the tool output already on screen.
   */
  private readonly silence = new SilenceWatch({
    warnAfterMs: SILENCE_WARN_MS,
    restartAfterMs: SILENCE_RESUME_MS,
    isRunning: () => this.busy && !this.abort.signal.aborted,
    isPaused: () => this.awaitingApproval > 0,
    canRestart: () => loadConfig().autoResume !== false,
    hasRestartsLeft: () => this.autoResumes < MAX_AUTO_RESUMES,
    onWarn: (idle) => {
      const more = Math.max(1, Math.round((SILENCE_RESUME_MS - idle) / 60_000));
      this.notice(
        `Nothing has come back from ChatGPT for ${Math.round(idle / 60_000)} minutes. Still waiting — OnFlip restarts the turn by itself in about ${more} more.`
      );
    },
    onRestart: (idle) => this.restartSilentTurn(idle),
    onExhausted: (idle) => {
      this.notice(
        `Still nothing after ${Math.round(idle / 60_000)} minutes, and ${MAX_AUTO_RESUMES} restarts have already been used. Press stop and send again when you are ready.`
      );
    },
  });

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

  private initInFlight: Promise<EngineStatus> | null = null;

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
    // A reload during a slow first start asked again before `connected` was
    // set, and the whole sequence ran twice at once — two transports, two
    // adoptions of the same session, two logs. The second caller now waits
    // for the first; a failure clears the way for a genuine retry.
    if (!this.initInFlight) {
      this.initInFlight = this.initOnce().finally(() => {
        this.initInFlight = null;
      });
    }
    return this.initInFlight;
  }

  private async initOnce(): Promise<EngineStatus> {
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

    const restored = this.adoptableSession(this.cwd);
    if (restored) {
      this.adoptStoredSession(restored);
    } else {
      this.session = createSession(this.cwd, this.model);
      this.history = this.session.messages;
      this.archived = this.session.archived ?? [];
    }
    this.holdSession();

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
    if (!this.transport || this.transport.name !== "browser") return;
    const cfg = loadConfig();

    // The plan decides how much transcript is worth keeping. Learned on its
    // own schedule: gating it behind the model list meant an account that
    // already knew its models — every account after the first run — would
    // never read its plan at all.
    if (!cfg.planType) {
      try {
        const plan = await fetchAccountPlan(this.auth.cookies);
        if (plan) {
          saveConfig({ planType: plan });
          const crowded = promptCrowdsPlan(plan, this.systemPromptChars());
          if (crowded) {
            this.notice(
              `This plan's context window is about ${Math.round(crowded.windowChars / 1000)}k characters and OnFlip's instructions take ${Math.round(
                crowded.systemChars / 1000
              )}k of it, so the conversation summarises itself often and long tasks are slower. A larger plan mostly buys room here.`
            );
          }
          logger.info("engine", "account plan", {
            plan,
            described: describePlan(plan),
            compactAt: compactionBudget(plan),
          });
        }
      } catch (e) {
        // A plan OnFlip cannot read simply leaves the composer ceiling in
        // charge, which is what it used before it could read one.
        logger.warn("engine", "could not read the account plan", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Refreshing is the once-per-machine half. Deciding the default is not:
    // it depends on the plan, and the plan can change under an account that
    // has known its models for months.
    if (!cfg.discoveredModels?.length) {
      try {
        await this.refreshModels();
      } catch (e) {
        logger.warn("engine", "could not read the account's model list", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.adoptDefaultModel();
    this.pushStatus();
  }

  /**
   * Decide, once, whether the stored model was chosen or merely adopted.
   *
   * Configs written before `modelPinned` existed do not say, and the two
   * cases need opposite treatment. What they do say is the slug, and the
   * only slug the old code ever wrote by itself was Luna — so anything
   * else in there was typed by a person and is theirs to keep. A Luna is
   * ambiguous, and is read as adopted: on Free and Go that decision
   * changes nothing, and above them Luna was rarely what anyone wanted
   * for themselves. Anyone it moves can move it back in one click, and
   * that click pins it for good.
   */
  private migrateModelPin(): void {
    const cfg = loadConfig();
    if (cfg.modelPinned !== undefined) return;
    saveConfig({ modelPinned: !!cfg.model && !/luna/i.test(cfg.model) });
  }

  /**
   * Move a session that was never pinned onto whatever the default now is.
   *
   * Runs every start rather than only the first, because both halves of the
   * default can move: the plan is read after the first run on most
   * machines, and an update can change what a plan defaults to.
   */
  private adoptDefaultModel(): void {
    this.migrateModelPin();
    const cfg = loadConfig();
    if (process.env.ONFLIP_MODEL) return;
    // A pin on Auto is not kept: Auto is ChatGPT's own router, which on a
    // paid plan sends an agent's turns into Pro thinking — measured as
    // thirty-second server errors and hand-offs to ChatGPT Work — and it
    // is no longer offered in the picker. The pin itself survives, on the
    // model the account actually runs well.
    if (cfg.modelPinned && this.model !== "auto") return;
    const wanted = defaultModel(cfg.planType);
    if (wanted === this.model) return;
    const from = this.model;
    this.model = wanted;
    saveConfig({ model: wanted });
    if (this.session) this.session.model = wanted;
    logger.info("engine", "adopted the default model", { from, to: wanted, plan: cfg.planType });
    this.notice(
      from === "auto"
        ? `Auto is no longer offered — on a paid plan it routed the agent's turns into Pro thinking, which kept timing out. Using ${wanted} instead; pick another model in the chip under the composer if you prefer.`
        : `Using ${wanted}, which this plan can run without a message limit.`
    );
  }

  /** Only the configuration that can be silently signed out needs probing. */
  private async checkSignInState(): Promise<void> {
    // DeepSeek is always probed. Its transport is also named "browser", and
    // the cookies in hand are ChatGPT's — so the shortcut below would read a
    // ChatGPT session as proof that DeepSeek is connected, and report a
    // signed-out account as ready. Reported from the field on the first
    // switch: "it says connected, but I have not signed in to DeepSeek".
    const deepseek = activeProvider() === "deepseek";
    if (!deepseek && (this.transport.name !== "browser" || this.auth.cookies.length > 0)) {
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
      const service = providerLabel();
      this.emitConnect(
        "signed-out",
        state.reachable
          ? `OnFlip is not signed in to ${service} — open the account menu (bottom left) and choose "Sign in".${why && !deepseek ? ` (${why})` : ""}`
          : `${service} could not be reached (${state.detail}).`
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
    this.archived = restored.archived ?? [];
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
        this.markActivity();
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

  /** The transcript size at which compaction fires — one number, two users. */
  /** The system prompt, which the send carries but compaction cannot touch. */
  private systemPromptChars(): number {
    return this.history[0]?.role === "system" ? this.history[0].content.length : 0;
  }

  private contextBudgetChars(): number {
    // An explicit setting wins; otherwise the model's published window,
    // then the plan, size the budget — 45k on a million-token Sol was
    // compacting every few turns of real work. The prompt's own size goes
    // in because the send carries it too: budgeting the transcript alone
    // is how a Free account ended up sending more than its window holds.
    // DeepSeek's ceiling is its own, and it is not the composer's: measured,
    // 80,069 characters arrived in one send and were read to the end.
    if (!this.config.compactAfterChars && activeProvider() === "deepseek") {
      return DEEPSEEK_CEILING_CHARS;
    }
    return (
      this.config.compactAfterChars ??
      compactionBudget(
        loadConfig().planType,
        uploadsAvailable(),
        modelContextTokens(this.model),
        this.systemPromptChars()
      )
    );
  }

  statusPayload(): EngineStatus {
    // Read once: this runs after every tool call, and the project lookup
    // below used to read the file twice more on its own.
    const cfg = loadConfig();
    const project = this.currentProject(cfg);
    return {
      version: ENGINE_VERSION,
      cwd: this.cwd,
      scratch: inScratch(this.cwd) || undefined,
      // The same measure the compaction trigger uses — the reclaimable part
      // of the transcript, excluding the system prompt it keeps verbatim.
      // Counting the whole transcript pinned the ring at 100% while nothing
      // compacted, because a 20k prompt inside a 45k budget starts the
      // gauge half-full on an empty conversation.
      contextChars: reducibleChars(this.history),
      contextBudget: this.contextBudgetChars(),
      provider: activeProvider(),
      planRationed: rationedPlan(cfg.planType) || undefined,
      planLimitTitle: planLimitCard(cfg.planType)?.title,
      planLimitNote: planLimitCard(cfg.planType)?.body,
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
      chatProject: project ? { id: project.id, name: project.name } : undefined,
      cooldownUntil: cfg.cooldownUntil && cfg.cooldownUntil > Date.now() ? cfg.cooldownUntil : undefined,
      headed: cfg.headed ?? false,
      busy: this.busy,
      queued: this.queue.map((q) => ({ id: q.id, text: q.text, attachments: q.attachments })),
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

  /** The panel telling the browser what shape to render at. */
  async setBrowserViewport(width: number, height: number, scale?: number): Promise<{ ok: boolean }> {
    await setBrowserViewport(width, height, scale);
    return { ok: true };
  }

  /** A click, key or scroll from the browser panel, replayed on the page. */
  async browserInput(input: BrowserUserInput): Promise<boolean> {
    return dispatchBrowserInput(input);
  }

  private accountKey(): string {
    return this.account?.email?.toLowerCase() || UNKNOWN_ACCOUNT;
  }

  private pushStatus(): void {
    this.holdSession();
    this.peer.emit("status", this.statusPayload());
  }

  private pushTranscript(): void {
    // Display shows the whole conversation; the model's context is the
    // compacted part alone.
    this.peer.emit("transcript", { items: replayItems([...this.archived, ...this.history]) });
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
    // A turn waiting on this prompt is waiting on a person, and however long
    // that takes it is not stuck. The watchdog holds off while it is up.
    this.awaitingApproval++;
    // Raced against the turn's own stop. Without that, Stop followed by Allow
    // ran the action after the stop — the tool was still awaiting an answer
    // nothing had cancelled — and a prompt the renderer lost to a reload left
    // the turn waiting for ever, with the watchdog paused for exactly that
    // wait. The signal is captured now: a queued turn installs a new one.
    const signal = this.abort.signal;
    let cancel: (() => void) | null = null;
    try {
      const asked = this.peer.request<ApprovalDecisionDTO>("approval", dto);
      // An answer that lands after the race has settled has nowhere to go.
      asked.catch(() => {});
      const stopped = new Promise<ApprovalDecisionDTO>((resolve) => {
        cancel = () => resolve({ allow: false });
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
      decision = await Promise.race([asked, stopped]);
    } catch {
      return { allow: false, reason: "the approval prompt was dismissed" };
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
      this.awaitingApproval--;
      this.markActivity();
    }

    if (signal.aborted) {
      // Tells main to forget the waiter and the renderer to take the modal
      // down; an answer given to it now would credit nothing.
      this.peer.emit("approval-cancelled", {});
      return { allow: false, reason: "the turn was stopped before this action was approved" };
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

  /**
   * Consecutive turns that were resumed without anyone asking.
   *
   * Reset by a person typing anything, and by a turn that finishes, so the
   * cap only ever counts one unbroken run of failures.
   */
  private autoResumes = 0;

  /** This turn was aborted by the watchdog, not by the user pressing stop. */
  private stallRestart = false;

  send(text: string, attachments?: string[]): { queued: boolean } {
    if (!this.connected) throw new Error("The engine is still connecting — try again in a moment.");
    this.autoResumes = 0;
    if (this.busy) {
      // A queued message keeps its own attachments: they belong to that
      // message, not to whichever turn happens to run next.
      this.queue.push({ id: randomUUID(), text, attachments });
      this.pushStatus();
      return { queued: true };
    }
    void this.runOneTurn(text, attachments);
    return { queued: false };
  }

  /** Something happened. Whatever it was, the turn is not wedged. */
  private markActivity(): void {
    this.silence.mark();
  }

  /**
   * Abandon a turn that stopped answering and start the work again.
   *
   * The transcript already holds everything done so far, so the queued word
   * carries it into a conversation that answers — the same move the user
   * makes by hand when a session wedges.
   */
  private restartSilentTurn(idleMs: number): void {
    this.autoResumes += 1;
    this.stallRestart = true;
    logger.warn("session", "turn went silent; restarting it", {
      idleMs,
      attempt: this.autoResumes,
    });
    this.notice(
      `Nothing has come back for ${Math.round(idleMs / 60_000)} minutes, so the turn is stuck. Starting it again in a fresh conversation (attempt ${this.autoResumes} of ${MAX_AUTO_RESUMES}).`
    );
    this.queue.push({ id: randomUUID(), text: RESUME_PROMPT, auto: true });
    this.abort.abort();
  }
  /**
   * Carry on by ourselves after a turn died on the transport.
   *
   * The word is the whole mechanism: "continue" is what a person types when
   * a long run stops with a red error, and it works because the next turn
   * opens a fresh conversation and re-sends the transcript. Nothing is
   * being retried — the failed request is gone, and the transcript that
   * outlived it is the thing that matters.
   *
   * Three, and then it stops. A cap is what separates recovering from a
   * conversation that broke from hammering at something genuinely wrong,
   * and stopping with the reason on screen is more useful than a loop.
   * Every attempt says so in the transcript, so a run that healed itself
   * overnight can still be read back afterwards.
   */
  private queueAutoResume(reason: string): void {
    if (loadConfig().autoResume === false) return;
    if (cooldownRemainingMs() > 0) return;
    if (this.queue.length > 0) return;
    // ChatGPT's own server error, already retried into a fresh chat by the
    // transport. On Auto the cause is almost certainly the model routing
    // (the error text says so); a second round of resends changes nothing
    // but the wait, so the advice is left standing instead.
    const serverError = /reached the model/.test(reason);
    if (serverError && /^auto$/i.test(this.model) && this.autoResumes >= 1) {
      this.notice(
        "Not trying again by itself: the same server error came back in a fresh chat too. Pick a fast model such as GPT-5.6 Luna in the chip under the composer, then say \"continue\"."
      );
      return;
    }
    if (this.autoResumes >= MAX_AUTO_RESUMES) {
      this.notice(
        `Stopped after ${MAX_AUTO_RESUMES} attempts to carry on. Say "continue" to try again, or turn off automatic resume in Settings.`
      );
      return;
    }
    // The resume is documented as carrying the work into a fresh
    // conversation. It only did so when something else had already dropped
    // the old one: measured, an automatic "continue" went straight back
    // into the thread that had just answered with a server error.
    if (serverError) this.transport?.reset();
    this.autoResumes += 1;
    logger.info("session", "resuming after a failed turn", {
      attempt: this.autoResumes,
      reason,
    });
    this.notice(
      `That chat stopped answering. Carrying on in a new one (attempt ${this.autoResumes} of ${MAX_AUTO_RESUMES}).`
    );
    // Into the queue rather than straight into a turn: the turn that just
    // failed is still in its own finally block, and that block is what
    // hands the next one over.
    this.queue.push({ id: randomUUID(), text: RESUME_PROMPT, auto: true });
  }

  interrupt(): void {
    // A resume OnFlip queued for itself is not something the user asked for.
    // Stop means stop: it goes, along with the turn it was going to follow.
    const auto = this.queue.filter((q) => q.auto).length;
    if (auto > 0) this.queue = this.queue.filter((q) => !q.auto);
    this.stallRestart = false;
    if (this.busy && !this.abort.signal.aborted) {
      this.abort.abort();
      logger.info("session", "interrupted by user", {
        queued: this.queue.length,
        cancelledResumes: auto,
      });
    }
    if (auto > 0) this.pushStatus();
  }

  clearQueue(): void {
    this.queue = [];
    this.pushStatus();
  }

  /**
   * Take one message back out of the queue.
   *
   * The text comes back so the caller can put it in the composer; a caller
   * that only wants it gone throws the text away. One method for both because
   * they are the same act — the message leaves the queue — and splitting them
   * would give two ways to race the turn that is draining it.
   *
   * Answers null when the id is not there any more, which is what happens
   * when the running turn finished and took the message with it between the
   * strip being drawn and the button being pressed.
   */
  unqueue(id: string): { text: string; attachments?: string[] } | null {
    const at = this.queue.findIndex((q) => q.id === id);
    if (at < 0) return null;
    const [taken] = this.queue.splice(at, 1);
    this.pushStatus();
    return { text: taken.text, attachments: taken.attachments };
  }

  private runningToolId: string | null = null;
  private toolIds = new Map<ToolCall, string>();
  /** The one wide sweep per process has run; later passes stay narrow. */
  private sweptAllSessions = false;

  /** Every ChatGPT conversation any stored session opened, current included. */
  private allKnownChatIds(): string[] {
    const ids = new Set<string>(this.session?.chatIds ?? []);
    try {
      for (const summary of listSessions({ limit: 200 })) {
        const stored = loadSession(summary.id);
        for (const id of stored?.chatIds ?? []) ids.add(id);
      }
    } catch {
      /* sweep what we have */
    }
    return [...ids];
  }

  /**
   * Write an image ChatGPT drew into the working folder.
   *
   * OnFlip has no image tool and is not going to grow one: the model
   * already draws, and what was missing was the last three inches — the
   * picture arrived in the chat and stayed there, so a request for a banner
   * produced something the user could look at and nothing they could use.
   *
   * Read-only sessions are left alone. Everywhere else this is the point of
   * having asked, so it does not go through the approval prompt: the file
   * is the answer to the request, not a side effect of one.
   */
  private saveReplyImage(image: { dataUrl: string; name: string }): string | null {
    if (this.approvalMode === "read-only") return null;
    const target = imageTarget(this.cwd, image.dataUrl, image.name);
    if (!target) return null;
    try {
      fs.writeFileSync(target.file, target.bytes);
      logger.info("session", "saved a generated image", {
        file: target.file,
        bytes: target.bytes.length,
      });
      return path.basename(target.file);
    } catch (e) {
      logger.warn("session", "could not save a generated image", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private async runOneTurn(text: string, attachments?: string[]): Promise<void> {
    this.busy = true;
    this.abort = new AbortController();
    this.silence.start();
    this.toolIds.clear();
    this.pushStatus();
    // What the workspace held before the turn, so its deliverables can be
    // picked out by diff afterwards.
    const scratchBefore = inScratch(this.cwd) ? scratchIndex(this.cwd) : null;
    this.peer.emit("turn", { state: "start" });

    // @skill tags expand into their full prompt for the model; the emitted
    // item keeps the compact tag, which the chat renders as a link.
    const userMessage = newMessage("user", expandMentions(expandSkillToken(text), this.cwd));
    // Files go to the browser transport as a side-channel: the payload is
    // text, and the composer uploads these alongside it. The model is told
    // in words too, so it knows to look at what was attached.
    // Refused here rather than only in the composer, because the composer is
    // not the only way in: Telegram forwards photos and documents into this
    // same call, and on a rationed plan an upload spends the one allowance
    // that stops the session when it runs out. The paths still reach the
    // agent as text, so it can open them from disk itself — which costs
    // nothing and is usually what was wanted anyway.
    const attachmentsBlocked = attachments?.length ? attachmentsBlockedReason() : null;
    if (attachments?.length && attachmentsBlocked) {
      this.notice(attachmentsBlocked);
      userMessage.content = `${userMessage.content}

[These files were named but not uploaded, because this plan rations uploads. Read them from disk if you need them: ${attachments.join(
        ", "
      )}]`;
    } else if (attachments?.length) {
      queueAttachments(attachments);
      userMessage.content = `${userMessage.content}

[Attached to this message: ${attachments
        .map((f) => path.basename(f))
        .join(", ")}]`;
    }
    // The item carries the history message's id so edit/resend can find it,
    // and delivery events can attach to it.
    // The attachments ride along so the transcript can show them. Without
    // this the chat showed the words and nothing else, and a picture that had
    // been sent looked exactly like one that had not.
    this.peer.emit("item", {
      type: "user",
      id: userMessage.id,
      text,
      attachments: attachments?.length ? attachments : undefined,
    } satisfies ChatItem);
    logger.info("session", "user turn", { text });
    this.history.push(userMessage);
    this.pendingDelivery = userMessage.id;
    this.pendingRead = userMessage.id;
    // On disk before the turn runs: the sidebar can show the session the
    // moment the question is asked, and a crash mid-turn cannot lose it.
    // Without this a first prompt was invisible for the whole turn, and if
    // the turn never finished it vanished without a trace.
    this.saveNow();

    // Kept for the workspace scan below: files the answer names by hand are
    // deliverables even when nothing on disk changed this turn.
    let finalAnswer = "";
    try {
      // Before anything can open a chat: the project the chat files into.
      await this.ensureOnFlipProject();
      const result = await runTurn(this.history, this.agentOptions());
      finalAnswer = result.finalAnswer;
      if (result.interrupted) {
        // The watchdog has already said what it is doing and queued the
        // word that continues the work; saying "interrupted" over the top
        // of that would read as the user having stopped it.
        if (!this.stallRestart) {
          this.notice("Interrupted. The work done so far is kept — say what to do next.");
        }
        this.stallRestart = false;
        this.peer.emit("turn", { state: "end", interrupted: true, iterations: result.iterations });
      } else if (result.exhausted) {
        this.peer.emit("turn", {
          state: "end",
          exhausted: true,
          iterations: result.iterations,
          error: `Stopped after ${result.iterations} of ${this.maxIterations} steps without finishing. Say "continue" to keep going, or raise the step budget in Settings.`,
        });
      } else {
        this.autoResumes = 0;
        this.peer.emit("turn", { state: "end", iterations: result.iterations });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = failureCodeOf(e);
      logger.error("session", "turn failed", {
        error: message,
        code,
        stack: e instanceof Error ? e.stack : undefined,
      });
      // A signed-out session is the one failure where carrying on by itself
      // is pure harm: every automatic "continue" opens another chat that
      // cannot work. The code says so directly now, rather than being
      // guessed at from the sentence.
      const resumable = isResumableFailure(message, code) && !this.abort.signal.aborted;
      this.peer.emit("item", {
        type: "error",
        id: randomUUID(),
        text: message,
        resumable,
      } satisfies ChatItem);
      this.peer.emit("turn", { state: "end", error: message });
      if (resumable) this.queueAutoResume(message);
    } finally {
      this.silence.stop();
      const composerWarning = takeComposerWarning();
      if (composerWarning) this.notice(composerWarning);

      // Images ChatGPT drew this turn. They live on the page, not on disk,
      // so they are fetched as data URLs and written into the working
      // folder here — the whole point of asking for one is to end up with
      // the file. The transcript still shows it; the folder now has it.
      const savedImages: string[] = [];
      for (const image of takeReplyImages()) {
        const saved = this.saveReplyImage(image);
        if (saved) savedImages.push(saved);
        this.peer.emit("item", {
          type: "image",
          id: randomUUID(),
          dataUrl: image.dataUrl,
          name: saved ?? image.name,
        } satisfies ChatItem);
      }
      if (savedImages.length > 0) {
        // Into the conversation, not just the screen. Without the filename
        // the model cannot reference what it just drew — the banner it was
        // asked for exists on disk and the page it writes next cannot
        // point at it.
        this.history.push(
          newMessage(
            "user",
            `[OnFlip] The image${savedImages.length > 1 ? "s" : ""} you generated ${
              savedImages.length > 1 ? "were" : "was"
            } saved into the working folder as ${savedImages.join(", ")}. ` +
              "Reference that filename if you use it from code, and do not generate it again."
          )
        );
        this.notice(
          savedImages.length > 1
            ? `Saved ${savedImages.length} generated images into the folder: ${savedImages.join(", ")}.`
            : `Saved ${savedImages[0]} into the folder.`
        );
      }

      // Folder-less chats: whatever the turn wrote into the scratch
      // workspace is the deliverable, so it is surfaced in the transcript
      // with a save button. Scanned rather than tracked through the tools,
      // because a document generated by a shell command is exactly as much
      // the deliverable as one written by the write tool.
      if (scratchBefore && inScratch(this.cwd)) {
        try {
          const files = scratchArtifacts(this.cwd, scratchBefore);
          for (const mentioned of mentionedArtifacts(this.cwd, finalAnswer)) {
            if (!files.some((f) => f.path === mentioned.path)) files.push(mentioned);
          }
          if (files.length > 0) {
            this.peer.emit("item", { type: "files", id: randomUUID(), files } satisfies ChatItem);
          }
        } catch (e) {
          logger.warn("session", "could not scan the scratch workspace", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
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
      // Every conversation the transport identified this turn, not only the
      // one a successful reply ended in: a turn that failed still created
      // chats, and an unrecorded chat is one the sweep below cannot rescue.
      if (this.session) {
        const ids = (this.session.chatIds ??= []);
        for (const id of [currentConversationId(), ...openedConversationIds()]) {
          if (id && !ids.includes(id)) ids.push(id);
        }
      }
      // Every chat this session ever opened belongs in the project, not just
      // the one still on screen — a filing that failed under a throttle used
      // to be abandoned the moment compaction opened the next thread. The
      // first pass of a process goes wider and sweeps every stored session's
      // chats, so strays left behind by earlier runs come home too.
      const sweepIds = this.sweptAllSessions
        ? (this.session?.chatIds ?? [])
        : this.allKnownChatIds();
      this.sweptAllSessions = true;
      if (sweepIds.length) {
        await sweepConversationsIntoProject(sweepIds).catch(() => {});
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
          // ChatGPT names a thread after what is in it, which for a thread
          // whose only content was OnFlip's own sentinel meant a session in
          // the sidebar called "[attachment unreadable]". Better no stored
          // title at all: the list then falls back to what the user asked.
          if (!title || isPlaceholderTitle(title)) return;
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
      // The variant the thinking level asks for, not the family the picker
      // shows: that is the slug the chat is opened with.
      model: effectiveModel(this.model, this.thinking),
      thinking: this.thinking,
      maxIterations: this.maxIterations,
      shellEnabled: this.shellEnabled && this.approvalMode !== "read-only",
      signal: this.abort.signal,
      compactAfterMessages: this.config.compactAfter ?? 60,
      // The ceiling here is the composer's, not the model's — OnFlip cannot
      // read the account's plan, so this is a local heuristic about what can
      // be typed, nothing to do with the context window the plan grants.
      // 30k compacted too eagerly, and compacting is not cheap either
      // (measured: ~2 minutes). 45k sits between a payload that types and a
      // summary run often enough to be its own tax.
      // Set by the user, or derived from the plan: a bigger window is worth
      // more transcript, and the composer's own ceiling caps both.
      // Uploads lift the typing ceiling, so the plan gets to be the limit.
      compactAfterChars: this.contextBudgetChars(),
      events: {
        onThinking: (iteration) => {
          this.markActivity();
          this.peer.emit("thinking", { iteration });
        },
        onDelta: (full) => {
          this.markActivity();
          // The first streamed characters prove ChatGPT received the message
          // and is answering — the "read" stage of the delivery badge.
          if (this.pendingRead) {
            this.peer.emit("delivery", { id: this.pendingRead, state: "read" });
            this.pendingRead = null;
          }
          const now = Date.now();
          if (now - this.lastDeltaAt < 150) return;
          this.lastDeltaAt = now;
          this.peer.emit("delta", { tail: presentableTail(full) });
        },
        onNarration: (narration) => {
          this.markActivity();
          this.peer.emit("item", {
            type: "narration",
            id: randomUUID(),
            text: narration,
          } satisfies ChatItem);
        },
        onToolStart: (call) => {
          this.markActivity();
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
          this.markActivity();
          const id = this.toolIds.get(call) ?? randomUUID();
          this.runningToolId = null;
          this.pendingArgs = null;
          this.peer.emit("tool-update", { id, result: this.convertResult(result) });
          if (call.tool.startsWith("todo")) {
            this.peer.emit("todos", { items: this.toolState.todos });
          }
          // Tool output is what fills the context, so this is the moment the
          // ring moves. Pushed only at turn boundaries, it sat still through
          // exactly the turns that were filling it.
          this.pushStatus();
        },
        onNotice: (noticeText) => {
          // A retry or a compaction is the transport working, not silence.
          this.markActivity();
          this.notice(noticeText);
        },
        // Compaction empties the context, not the conversation: keep what it
        // dropped so the transcript still reads as one.
        onCompacted: (dropped) => {
          this.archived = [...this.archived, ...dropped];
        },
        onFinal: (final, meta) => {
          // A question is an answer that needs one back, and is drawn so.
          if (meta?.kind === "ask_user") {
            this.peer.emit("item", {
              type: "question",
              id: randomUUID(),
              text: final,
              options: meta.options,
            } satisfies ChatItem);
            return;
          }
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
    this.archived = this.session.archived ?? [];
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

  /**
   * Read a session's transcript without switching to it.
   *
   * Deliberately free of assertIdle: this is how a history stays readable
   * while a turn is running. Nothing engine-side moves — the transcript is
   * rebuilt from the stored session on disk, exactly the way resuming would
   * rebuild it, and the running session never notices.
   */
  peekSession(id: string): { title: string; cwd: string; items: ChatItem[] } {
    const stored = loadSession(id);
    if (!stored) throw new Error("That session could not be read.");
    return {
      title: deriveTitle(stored),
      cwd: stored.cwd,
      items: replayItems([...(stored.archived ?? []), ...stored.messages]),
    };
  }

  async resumeSession(id: string): Promise<EngineStatus> {
    this.assertIdle();
    const restored = loadSession(id);
    if (!restored) throw new Error("That session could not be read.");
    if (restored.id !== this.session?.id && sessionHeldElsewhere(restored.id)) {
      throw new Error("That session is open in another OnFlip window.");
    }
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
   * The cookies are written to config the same way the browser import writes
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
      // The user has just told OnFlip which session to use, so this jar goes
      // into the browser profile whatever that profile is already holding.
      // Every *other* start leaves the profile's own session alone — see
      // `sessionCookiesPending`, and the run it cost to learn the difference.
      sessionCookiesPending: true,
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
    this.notice(`Signed in to ${providerLabel()} — the session is saved and ready to use.`);
    this.pushStatus();
    return { ok: true };
  }

  /**
   * Sign in by importing a session already open in Chrome, Edge or Firefox.
   *
   * The same reader the sign-in prompt uses, run on demand rather than at
   * startup — so it works even while the app is signed out, which is
   * exactly when someone reaches for it. What it cannot do is decrypt
   * Chrome-family cookies on current Windows: those use app-bound
   * encryption, and the reader says so rather than pretending the account
   * was not found.
   */
  async importBrowserSession(): Promise<{
    ok: boolean;
    source?: string;
    reason?: string;
    report?: { browser: string; outcome: string; detail?: string }[];
  }> {
    const extracted = spawnExtractToken();
    const report = lastBrowserFindings();
    // Logged either way. This ran silently before, so an import that failed
    // on someone else's machine left nothing behind to diagnose it with.
    logger.info("engine", "browser session import", {
      found: Boolean(extracted?.cookies.length),
      source: extracted?.source,
      report,
    });
    if (extracted?.cookies.length) {
      await this.applySignIn(extracted.cookies);
      return { ok: true, source: extracted.source, report };
    }
    return {
      ok: false,
      reason:
        takeExtractError() ??
        "No signed-in ChatGPT session was found in any browser on this machine.",
      report,
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
      `Signed out of ${providerLabel()}. Use "Sign in to ${providerLabel()}" in the account menu when you want to work again.`
    );
    this.notice("Signed out — the stored session and the browser profile have been cleared.");
    this.pushStatus();
    return { ok: true };
  }

  /** Which browser a sign-in would open, for the button that offers it. */
  signInBrowserInfo(): { name: string; channel: string } | null {
    const pick = pickSignInBrowser();
    return pick ? { name: pick.name, channel: pick.channel } : null;
  }

  /**
   * Sign in through a real browser on OnFlip's own profile (see
   * `signInWithRealBrowser` in the core for why this is the way in).
   *
   * On success nothing stored may be injected into that profile any more: a
   * stale token replayed into a signed-in profile signs it out — the trap
   * AGENTS.md records — so the stored session is cleared and the profile is
   * the session from here on.
   */
  async signInWithBrowser(): Promise<{ ok: boolean; reason?: string; browser?: string }> {
    this.assertIdle();
    const result = await signInWithRealBrowser((state) => this.peer.emit("sign-in", { state }));
    if (!result.ok || !result.browser) return { ok: false, reason: result.reason };

    clearConfigKeys([
      "sessionToken",
      "sessionCookies",
      "sessionCookieName",
      "sessionDeviceId",
      "accessToken",
      "accessTokenExpiry",
    ]);
    saveConfig({
      signedOut: false,
      persistProfile: true,
      browserChannel: result.browser.channel,
    });
    this.config = loadConfig();
    if (this.auth) {
      this.auth.cookies.length = 0;
      this.auth.sessionToken = "";
      this.auth.accessToken = "";
    }
    this.probeSignedIn = true;
    this.account = null;
    this.transport?.reset();
    this.maybeIdentifyAccount();
    this.emitConnect("ready");
    this.notice(
      `Signed in to ${providerLabel()} with ${result.browser.name}. The session lives in OnFlip's own browser profile and is kept between launches.`
    );
    this.pushStatus();
    return { ok: true, browser: result.browser.name };
  }

  finishBrowserSignIn(): boolean {
    return finishRealBrowserSignIn();
  }

  cancelBrowserSignIn(): boolean {
    return cancelRealBrowserSignIn();
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
    // Scratch workspaces are sessions, not projects: they already appear in
    // the session list, and a "recent projects" menu full of chat-… folders
    // buries the real ones.
    return recentProjects(20).filter((p) => !inScratch(p.cwd));
  }

  /** Start a folder-less chat in a fresh private workspace. */
  async openScratch(): Promise<EngineStatus> {
    this.assertIdle();
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    const dir = path.join(scratchRoot(), `chat-${stamp}-${randomUUID().slice(0, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    return this.openProject(dir);
  }

  async openProject(dir: string): Promise<EngineStatus> {
    this.assertIdle();
    const target = resolveDir(this.cwd, dir);
    if (path.resolve(target) === path.resolve(this.cwd)) return this.statusPayload();

    this.saveNow();
    this.relocate(target);
    const restored = this.adoptableSession(target);
    if (restored) {
      this.adoptStoredSession(restored);
      this.seedSystemPrompt();
      if (restored.chatId) await this.reattachChat();
    } else {
      this.session = createSession(target, this.model);
      this.history = this.session.messages;
    this.archived = this.session.archived ?? [];
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
    // A scratch chat has no project to explain, but it does have a contract
    // the model must know: files written here reach the user as downloads,
    // so "generate a document" means writing a file, not pasting content.
    if (inScratch(target)) {
      this.context = {
        ...this.context,
        environment: [
          this.context.environment,
          "",
          "This is a folder-less chat session. The working directory is a private scratch workspace; the user has not opened any project. " +
            "Every file you create or change in this workspace is offered to the user in the chat as a download after the turn, and any workspace file you name in your final answer gets its download button again. " +
            "When asked to produce a document, spreadsheet, image, or any other file, write it as a real file in the working directory rather than pasting its content into the reply. " +
            "Never copy files into the user's own folders (Downloads, Desktop, Documents) — when the user asks to download a file, make sure it exists in the working directory and state its file name in your answer; the app handles the download from there.",
        ].join("\n"),
      };
    }
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
    const normalized = normalizeModel(slug) ?? defaultModel(loadConfig().planType);
    const changed = normalized !== this.model;
    this.model = normalized;
    saveConfig({ model: normalized, modelPinned: true });
    this.session.model = normalized;
    if (changed) this.applyModelChange("model");
    this.pushStatus();
    return this.statusPayload();
  }

  /**
   * A model or thinking change has to reach ChatGPT, and the only handle on
   * either is the URL a chat is opened with. Left alone, the live thread
   * kept answering on the old model until something else happened to open
   * a new one — a switch to Luna during a Pro-thinking stall changed
   * nothing, which read as the setting being broken. So the next message
   * opens a fresh chat and replays the transcript into it.
   */
  private applyModelChange(what: "model" | "thinking"): void {
    if (this.busy) {
      this.notice(
        `The ${what} change applies from the next chat OnFlip opens — the running turn keeps its current one.`
      );
      return;
    }
    this.transport?.reset();
    this.notice(
      `The ${what} change applies from your next message, which starts a fresh chat with the conversation so far.`
    );
  }

  setThinking(level: ThinkingLevel | null): EngineStatus {
    const changed = (level ?? undefined) !== this.thinking;
    this.thinking = level ?? undefined;
    saveConfig({ thinking: level ?? undefined });
    if (changed) this.applyModelChange("thinking");
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
      // Matches the tool's own default: windowless, since the desktop
      // mirrors that browser in its panel.
      browserHeadless: cfg.browserHeadless ?? true,
      maxIterations: firstPositiveInt([cfg.maxIterations], 40),
      replyTimeout: firstPositiveInt([cfg.replyTimeout], 600),
      // The effective value, not a hardcoded default: with nothing set, the
      // budget is sized from the plan and the model, and showing "45000"
      // here made auto-sizing look like a stuck setting.
      compactAfterChars: cfg.compactAfterChars ?? this.contextBudgetChars(),
      autoResume: cfg.autoResume !== false,
      rules,
      allowedCommands: cfg.allowedCommands ?? [],
      allowedWriteDirs: cfg.allowedWriteDirs ?? [],
    };
  }

  /**
   * Everything a bug report needs, in one block the user can paste.
   *
   * Written because every stall reported so far began with someone being
   * asked to find their log directory. The facts that actually decide these
   * questions — which plan, which model, which runtime read the cookies,
   * what each browser said — are spread across four places, and none of
   * them is the transcript. No cookie, token or account address goes in:
   * this is meant to be pasted into a public issue.
   */
  diagnostics(): { text: string } {
    const cfg = loadConfig();
    const cooldown = cooldownRemainingMs();
    const lines: string[] = [];
    const add = (label: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      lines.push(`${label.padEnd(16)} ${String(value)}`);
    };

    lines.push("OnFlip diagnostics");
    lines.push("");
    add("version", ENGINE_VERSION);
    add("platform", `${process.platform} ${process.arch} · ${os.release()}`);
    add("engine", `node ${process.versions.node} · module ABI ${process.versions.modules}`);
    add("cookie reader", process.env.ONFLIP_ELECTRON_PATH ? "the app's own runtime" : "whatever node is on PATH");
    lines.push("");
    add("plan", describePlan(cfg.planType) ?? cfg.planType ?? "not read");
    add("model", `${this.model}${cfg.modelPinned ? " (pinned)" : " (default)"}`);
    add("thinking", this.thinking ?? "off");
    add("context", `${reducibleChars(this.history)} of ${this.contextBudgetChars()} chars`);
    add("transport", this.transport?.name);
    add("uploads", uploadsAvailable() ? "available" : "unavailable");
    add("signed in", this.hasSession() ? "yes" : "no");
    add("cooldown", cooldown > 0 ? `${Math.ceil(cooldown / 1000)}s remaining` : "none");
    lines.push("");
    add("approval", this.approvalMode);
    add("shell", this.shellEnabled ? "on" : "off");
    add("network", this.networkEnabled ? "on" : "off");
    add("auto resume", cfg.autoResume === false ? "off" : "on");
    add("workspace", inScratch(this.cwd) ? "chat (no folder)" : "folder");
    add("log", logFile() ?? "not open");

    const browsers = lastBrowserReport();
    if (browsers.length) {
      lines.push("");
      lines.push("browser sign-in, last attempt");
      for (const r of browsers) {
        lines.push(`  ${r.browser.padEnd(10)} ${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`);
      }
    }

    // The checks go at the top of the paste, before the state dump. A bug
    // report that opens with "session: fail — sign in again" is one nobody
    // has to read the rest of.
    const health = runDoctor();
    lines.unshift(
      ...health.checks.map((c) => `  ${c.status.toUpperCase().padEnd(4)} ${c.title.padEnd(18)} ${c.message}`),
      ""
    );
    lines.unshift(`health checks: ${health.status}`, "");

    return { text: lines.join("\n") };
  }

  /**
   * The health checks on their own, typed, for a UI that wants to draw them.
   *
   * `diagnostics()` embeds the same report in its text blob for pasting into
   * an issue; this is the same data before it was flattened.
   */
  doctor(): DoctorReport {
    return runDoctor();
  }

  /**
   * The checks, plus the one that asks ChatGPT's own page whether the
   * selectors still match it.
   *
   * Refused mid-turn: the live half is read-only and runs on a throwaway
   * page, but starting a browser launch underneath a running turn is a
   * needless way to make one fail.
   */
  async deepDoctor(): Promise<DoctorReport> {
    if (this.busy) {
      const base = runDoctor();
      return {
        checks: [
          ...base.checks,
          {
            id: "selectors",
            title: "ChatGPT page",
            status: "warn" as const,
            message: "Skipped while a turn is running — try again once it has finished.",
          },
        ],
        status: base.status === "fail" ? "fail" : "warn",
      };
    }
    return runDeepDoctor(() => checkSelectorsLive(this.auth?.cookies ?? []));
  }

  setConfigValue(key: string, value: unknown): ConfigView {
    const allowed: Record<string, (v: unknown) => Partial<OnFlipConfig>> = {
      headed: (v) => ({ headed: Boolean(v) }),
      browserHeadless: (v) => ({ browserHeadless: Boolean(v) }),
      autoResume: (v) => ({ autoResume: Boolean(v) }),
      maxIterations: (v) => ({ maxIterations: firstPositiveInt([v as number], 40) }),
      replyTimeout: (v) => ({ replyTimeout: firstPositiveInt([v as number], 600) }),
      compactAfterChars: (v) => ({ compactAfterChars: firstPositiveInt([v as number], 45_000) }),
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
      // What compaction is about to drop stays visible: it leaves the
      // context, not the conversation.
      await compactNow(this.history, this.agentOptions());
      this.notice("Transcript compacted — earlier messages stay on screen, but are no longer sent.");
      this.pushTranscript();
      return { ok: true };
    } finally {
      this.peer.emit("turn", { state: "end" });
      // A message sent while this ran was queued, and is handed on here the
      // way a finished turn hands on — left in the queue it waited for the
      // *next* message and then ran after it, out of order.
      const next = this.queue.shift();
      this.busy = next !== undefined;
      this.saveNow();
      this.pushStatus();
      if (next !== undefined) void this.runOneTurn(next.text, next.attachments);
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
      // The whole diff, not a preview: this is the modal whose job is showing
      // everything, and it pages what it renders rather than relying on the
      // payload being small.
      out.push(
        buildFileDiff(file, this.cwd, before ?? "", after ?? "", {
          maxLines: FULL_MAX_LINES,
          maxChars: FULL_MAX_CHARS,
        })
      );
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
    // The whole conversation, not just the part still in context: an export
    // taken after a compaction held two messages and looked like the session
    // had been thrown away.
    for (const m of [...this.archived, ...this.history]) {
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
    this.session.title =
      title && !isPlaceholderTitle(title) ? title : "ChatGPT conversation";
    this.session.chatId = id;
    this.history = this.session.messages;
    this.archived = this.session.archived ?? [];
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

  private currentProject(cfg = loadConfig()): RemoteProject | null {
    const { projectId, projectShortUrl, projectName } = cfg;
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

  /** The session this engine has marked as its own on disk. */
  private heldSessionId: string | null = null;

  /**
   * Mark the current session as this engine's, and let go of the last one.
   *
   * Two windows opened in the same folder both adopted the latest session
   * there — a new window starts where the last one was — and each wrote the
   * whole transcript on every save, so whichever saved last erased the
   * other's turns. The lock is what lets `adoptableSession` start a fresh
   * session instead. Called wherever the session can have changed; the id
   * comparison makes the repeat calls free.
   */
  private holdSession(): void {
    // A session that has never been written cannot be adopted by anyone, so
    // it needs no lock; claiming it left a lock file behind for every empty
    // launch. The claim happens on the first save instead.
    const id = this.session && sessionFileExists(this.session.id) ? this.session.id : null;
    if (id === this.heldSessionId) return;
    if (this.heldSessionId) releaseSessionLock(this.heldSessionId);
    this.heldSessionId = null;
    if (id) {
      claimSessionLock(id);
      this.heldSessionId = id;
    }
  }

  /** The folder's latest session, unless another live engine is writing it. */
  private adoptableSession(cwd: string): StoredSession | null {
    const latest = latestSession(cwd);
    if (latest && sessionHeldElsewhere(latest.id)) {
      logger.info("session", "latest session is open in another window; starting a new one", {
        cwd,
        session: latest.id,
      });
      return null;
    }
    return latest;
  }

  private saveNow(): void {
    this.holdSession();
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
    this.session.archived = this.archived;
    this.session.todos = this.toolState.todos;
    this.session.snapshots = this.toolState.snapshots;
    this.session.model = this.model;
    saveSession(this.session);
    this.savedFingerprint = current;
    // Now that the file exists, the lock can name it.
    this.holdSession();
  }

  async shutdown(): Promise<void> {
    this.abort.abort();
    this.saveNow();
    if (this.heldSessionId) releaseSessionLock(this.heldSessionId);
    this.heldSessionId = null;
    killAllJobs();
    logger.info("session", "desktop engine ended");
    closeLog();
    await closeBrowser();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the streaming tail, as a person should see it
// ---------------------------------------------------------------------------

/**
 * What the "writing" line shows while a reply streams in.
 *
 * The raw page text carries the protocol: fence markers, and the `tool:`
 * block the model is in the middle of typing. Shown as-is it reads as the
 * app glitching — a row of backticks, then half a command. A finished tool
 * block becomes a short label, an unfinished one a note that a call is
 * being written, and bare fence lines are dropped; the prose around them is
 * what people are actually waiting to read.
 */
export function presentableTail(full: string): string {
  const lines = full.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceIsCall = false;
  let fenceTool = "";
  let fenceStart = -1;
  /**
   * The summary of a `done` block, or the question of an `ask_user` one, is
   * prose the person is waiting to read — it streams as itself, not as a
   * "▸ done call" label.
   */
  let closingBody: string[] = [];
  let inClosingBody = false;
  const flush = (label: string): void => {
    const replacement = isClosingBlock(fenceTool) && closingBody.length ? closingBody : [label];
    out.splice(fenceStart, out.length - fenceStart, ...replacement);
  };
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceIsCall = false;
        fenceTool = "";
        fenceStart = out.length;
        closingBody = [];
        inClosingBody = false;
      } else {
        inFence = false;
        if (fenceIsCall) flush(`▸ ${fenceTool || "tool"} call`);
      }
      continue;
    }
    if (inFence && !fenceIsCall && out.length === fenceStart) {
      const m = /^\s*tool\s*:\s*([A-Za-z0-9_.-]+)/i.exec(line);
      if (m) {
        fenceIsCall = true;
        fenceTool = m[1];
        continue;
      }
    }
    if (inFence && fenceIsCall) {
      if (isClosingBlock(fenceTool)) {
        const inline = /^\s*(?:summary|question)\s*:\s*(\S.*)$/i.exec(line);
        if (/^\s*(?:summary|question)\s*:\s*[|>]?\s*$/i.test(line)) {
          inClosingBody = true;
        } else if (inline && !/^[|>]$/.test(inline[1].trim())) {
          closingBody.push(inline[1]);
          inClosingBody = false;
        } else if (inClosingBody && /^\s+\S/.test(line)) {
          closingBody.push(line.replace(/^ {1,2}/, ""));
        } else if (inClosingBody && !line.trim()) {
          closingBody.push("");
        } else {
          // Another key, such as `options:`.
          inClosingBody = false;
        }
      }
      continue;
    }
    out.push(line);
  }
  if (inFence && fenceIsCall) flush(`▸ writing a ${fenceTool || "tool"} call…`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd().slice(-240);
}

/** `done` and `ask_user`, under every name the registry folds onto them. */
function isClosingBlock(tool: string): boolean {
  return /^(?:done|finish|final_answer|attempt_completion|complete|completed|submit|final|end_turn|ask_user|ask|ask_followup_question|ask_question|question|clarify)$/i.test(
    tool.replace(/[-\s]/g, "_")
  );
}

// ---------------------------------------------------------------------------
// session locks — one live engine per session file
// ---------------------------------------------------------------------------

function sessionLockFile(id: string): string {
  return path.join(configDir(), "sessions", `${id}.lock`);
}

function sessionFileExists(id: string): boolean {
  return fs.existsSync(path.join(configDir(), "sessions", `${id}.json`));
}

/**
 * Is another engine that is still running writing this session?
 *
 * The lock names a pid; a pid that no longer exists is a crash's leftover,
 * does not count, and is removed so it cannot pile up. EPERM from the probe
 * means the process exists but is not ours to signal, which for this
 * purpose is "alive".
 */
export function sessionHeldElsewhere(id: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionLockFile(id), "utf8")) as { pid?: number };
    if (!raw.pid || raw.pid === process.pid) return false;
    try {
      process.kill(raw.pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
      fs.rmSync(sessionLockFile(id), { force: true });
      return false;
    }
  } catch {
    return false;
  }
}

export function claimSessionLock(id: string): void {
  try {
    fs.mkdirSync(path.dirname(sessionLockFile(id)), { recursive: true });
    fs.writeFileSync(sessionLockFile(id), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    /* a lock that cannot be written is a lock nobody else can read either */
  }
}

export function releaseSessionLock(id: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionLockFile(id), "utf8")) as { pid?: number };
    if (raw.pid === process.pid) fs.rmSync(sessionLockFile(id), { force: true });
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// scratch chats — sessions with no project folder of their own
// ---------------------------------------------------------------------------

/**
 * Where folder-less chats live: one directory per chat under ~/.onflip.
 *
 * A chat still needs somewhere for the files it produces — "make me a Word
 * document" has to write the document — so instead of making the user pick a
 * folder first, the chat gets a private workspace and the files come back to
 * them as downloads in the transcript. The directory is real and ordinary on
 * purpose: sessions stay keyed by cwd, resume follows the cwd, and every
 * tool works unchanged.
 */
export function scratchRoot(): string {
  return path.join(configDir(), "scratch");
}

/**
 * Where an image ChatGPT drew should land, and the bytes to put there.
 *
 * Separated from the writing so the decisions can be checked without an
 * engine: which extension the data URL implies, what a safe file name is,
 * and — the one that matters — that an existing file is never replaced. A
 * second banner in a folder is a second file; the first one may already be
 * referenced by a page the agent wrote an hour ago.
 */
export function imageTarget(
  dir: string,
  dataUrl: string,
  suggestedName: string,
  exists: (file: string) => boolean = fs.existsSync
): { file: string; bytes: Buffer } | null {
  const match = /^data:image\/([a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim()
  );
  if (!match) return null;
  const type = match[1].toLowerCase();
  const ext = type === "jpeg" ? "jpg" : type === "svg+xml" ? "svg" : type;
  const base =
    suggestedName
      .replace(/\.[^.]*$/, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^[-.]+/, "") || "chatgpt-image";
  let file = path.join(dir, `${base}.${ext}`);
  for (let n = 2; exists(file); n++) file = path.join(dir, `${base}-${n}.${ext}`);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  return bytes.length > 0 ? { file, bytes } : null;
}

export function inScratch(dir: string): boolean {
  const rel = path.relative(scratchRoot(), path.resolve(dir));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Every file in a scratch workspace, fingerprinted for turn-end diffing. */
export function scratchIndex(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, depth: number): void => {
    if (out.size >= 2_000 || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= 2_000) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        out.set(full, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        /* deleted mid-scan */
      }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * Files the turn added or changed, by diff against the pre-turn index.
 *
 * A diff rather than a timestamp cutoff, and the difference is copies:
 * Copy-Item and cp preserve the source file's mtime, so a workbook copied
 * into the workspace this turn carried a timestamp from days earlier and a
 * "modified since the turn began" scan reported nothing — the user asked
 * for the download link the copy was made for, and there was none to give.
 * Existence is the fact that matters, and the diff measures exactly that.
 */
export function scratchArtifacts(
  dir: string,
  before: Map<string, string>,
  cap = 20
): { name: string; path: string; size: number }[] {
  const out: { name: string; path: string; size: number }[] = [];
  for (const [full, sig] of scratchIndex(dir)) {
    if (out.length >= cap) break;
    if (before.get(full) === sig) continue;
    try {
      out.push({ name: path.relative(dir, full), path: full, size: fs.statSync(full).size });
    } catch {
      /* deleted between scans */
    }
  }
  return out;
}

/**
 * Workspace files the reply names, offered again as downloads.
 *
 * The diff catches what a turn created; this catches what a turn was asked
 * for. "Can I download that file?" about a workbook already sitting in the
 * workspace changes nothing on disk, so the diff rightly stays silent — and
 * the user was left with a path in prose and no button. A file the model
 * mentions by name in its final answer is being handed over, whenever it
 * was made.
 */
export function mentionedArtifacts(
  dir: string,
  answer: string,
  cap = 20
): { name: string; path: string; size: number }[] {
  const text = (answer ?? "").trim();
  if (!text) return [];
  const out: { name: string; path: string; size: number }[] = [];
  for (const [full] of scratchIndex(dir)) {
    if (out.length >= cap) break;
    const base = path.basename(full);
    // Short names ("a.txt") match prose by accident; a real handover names
    // the file properly. The boundary check keeps "report.docx" from
    // matching inside "other-report.docx".
    if (base.length < 5) continue;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}`, "u").test(text)) continue;
    try {
      out.push({ name: path.relative(dir, full), path: full, size: fs.statSync(full).size });
    } catch {
      /* deleted between scans */
    }
  }
  return out;
}

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
