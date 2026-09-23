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
  unsentPromptToRestore,
  OnFlipConfig,
} from "onflip/dist/config";
import {
  allModels,
  normalizeModel,
  defaultModel,
  effectiveModel,
  modelContextTokens,
  modelBelongsToProvider,
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
  COMPOSER_CEILING_CHARS,
  DEEPSEEK_CEILING_CHARS,
  QWEN_CEILING_CHARS,
  describePlan,
  planLimitCard,
  promptCrowdsPlan,
  rationedPlan,
} from "onflip/dist/chatgpt/plans";
import { activeProvider, isBrowserProvider, providerLabel } from "onflip/dist/providers/id";
import {
  reportsSignedIn,
  watchVerdict,
  sessionEndedNotice,
} from "onflip/dist/providers/signed-in";
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
import { recordSend, usageSummary, associateAccount, closeUsageStore, UNKNOWN_ACCOUNT } from "./usage";
import { adoptRestoredRevision, restoreSnapshot, snapshotStillCurrent, snapshotToken } from "./undo";
import { claimSessionLock, releaseSessionLock, sessionHeldElsewhere } from "./session-lock";
import {
  createToolRegistry,
  createSessionState,
  killAllJobs,
  resetShellCwd,
  getShellCwd,
} from "onflip/dist/tools";
import { buildSystemPrompt } from "onflip/dist/agent/system";
import {
  loadProjectContext,
  MAX_INSTRUCTION_BYTES,
  MAX_INSTRUCTION_TOTAL_BYTES,
  ProjectContext,
} from "onflip/dist/agent/context";
import { newMessage } from "onflip/dist/agent/protocol";
import type { SubAgentRequest, SubAgentResult } from "onflip/dist/tools/task";
import {
  runTurn,
  compactNow,
  reducibleChars,
  AgentOptions,
  COMPACT_AFTER_MESSAGES_BACKSTOP,
} from "onflip/dist/agent/run";
import {
  ApprovalMode,
  isApprovalMode,
  clampApprovalMode,
  availableModes,
  createPolicy,
  evaluate,
  remember,
  commandKey,
  rememberableWriteDir,
  isInstructionFile,
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
import { openLog, closeLog, logger, logFile, diagnosticLogLines } from "onflip/dist/log";
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
  SubTaskDTO,
} from "../shared/protocol";
import { buildFileDiff, FULL_MAX_CHARS, FULL_MAX_LINES } from "./diffs";
import { replayItems, stripUserNotes } from "./replay";
import { expandSkillToken } from "../shared/skills";
import { displayArgs, subjectFor } from "./subjects";
import { SilenceWatch } from "./silence";
import { SESSION_WATCH_MS, idleStep, lookOnWake } from "./idle";
import { presentableTail } from "./presentable";
import { recordableChatIds } from "./chat-ids";

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
 * Steps a turn may take before it stops and asks to carry on.
 *
 * 100, raised from 40. The budget is a fuse against a turn spending the
 * account on nothing, and 40 was cutting off real work as often as it caught
 * a runaway — a build, a test run and a couple of fixes is dozens of steps
 * before anything has gone wrong. What made the higher number affordable is
 * that the loop can now tell thrash from work: repeated failures and protocol
 * nudges are counted, a turn stopped mid-stride earns one bounded extension,
 * and a spinning turn still stops. Written once because four places used to
 * spell it out and a default that disagrees with itself is a bug waiting.
 */
const DEFAULT_STEP_BUDGET = 100;

/**
 * How long stop is given to land before the browser is closed to force it.
 *
 * Stopping works by aborting a signal, which only stops anything if something
 * is watching it. Every loop in the drivers does — but a `page.evaluate` on a
 * renderer whose JavaScript thread is blocked never returns at all, so the
 * loop never comes back around to look, and the turn cannot be stopped by
 * asking. Reported that way: a turn silent for nearly six minutes with stop
 * doing nothing.
 *
 * Closing the browser makes every pending call reject, which is the one lever
 * that does not depend on the page cooperating. Five seconds, because a stop
 * that lands normally lands in about half of one — measured — so this only
 * ever fires when the polite route has already failed.
 */
const FORCE_STOP_MS = 5_000;

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
/**
 * How many of a sub-agent's steps the panel keeps.
 *
 * A summary somebody reads to follow the work, not a second transcript. One
 * that ran fifty greps should say so rather than list them, and the answer
 * it hands back is the thing that actually matters.
 */
const SUB_TASK_ACTIVITY_MAX = 40;

export class Engine {
  private config = loadConfig();
  private auth!: ResolvedAuth;
  private transport!: Transport;
  private transportReason = "";
  /** Last answer from the sign-in probe, when one has run. */
  private probeSignedIn: boolean | null = null;
  /**
   * Sub-tasks this session has run, for the panel that shows them.
   *
   * In memory and per session on purpose: this is "what is the agent doing",
   * not an audit trail, and a sub-agent's work is only interesting beside
   * the conversation that asked for it.
   */
  private subTasks: SubTaskDTO[] = [];
  /** The background session re-check and idle clock; see `startSessionWatch` and `idle.ts`. */
  private sessionWatch: ReturnType<typeof setInterval> | null = null;
  /** One check at a time; a slow one must not stack up behind itself. */
  private watchInFlight = false;
  /** A session was found signed in, so the clock's checks have something to watch. */
  private watching = false;
  /** When anything was last asked of this engine: a turn, or the window coming to the front. */
  private lastActiveAt = Date.now();
  /** When the watch last asked the service. */
  private lastCheckAt = 0;
  /** The service's browser was closed for idleness and has not been reopened. */
  private parked = false;
  /** The close in progress, which a send or a check waits out rather than racing. */
  private parking: Promise<void> | null = null;
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
  /** Where the running turn was asked from; absent means the desktop window. */
  private turnOrigin: "telegram" | undefined;
  /** Set by the app: a Telegram bot is running and can receive files. */
  private deliverable = false;
  /** `auto` marks a turn OnFlip queued for itself, which stop may cancel. */
  private queue: {
    id: string;
    text: string;
    attachments?: string[];
    auto?: boolean;
    /** Where it was asked from; absent means the desktop window. */
    origin?: "telegram";
  }[] = [];
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
      // An absolute time rather than "in about 4 more". The notice is written
      // once and then sits in the transcript while the clock runs, so a
      // countdown in it is wrong within a minute and reads as a broken
      // promise by minute five — reported exactly that way.
      const at = Math.round(SILENCE_RESUME_MS / 60_000);
      this.notice(
        `Nothing has come back from ${providerLabel()} for ${Math.round(idle / 60_000)} minutes. Still waiting — if nothing arrives by ${at} minutes of silence, OnFlip restarts the turn by itself. Stop ends it now.`
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
    // Clamped on read as well as on write, so a value stored by another
    // machine - or by a build before this rule - cannot put a Mac back
    // into full access without anyone choosing it.
    this.approvalMode = clampApprovalMode(
      isApprovalMode(cfg.approvalMode ?? "") ? (cfg.approvalMode as ApprovalMode) : "ask"
    );
    this.shellEnabled = cfg.shell ?? true;
    this.networkEnabled = cfg.network ?? true;
    this.maxIterations = firstPositiveInt(
      [process.env.ONFLIP_MAX_ITERATIONS, cfg.maxIterations],
      DEFAULT_STEP_BUDGET
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

  /**
   * The engine's side of every send, around whichever transport was chosen.
   *
   * Counting rides on it — one send is one request against the account's
   * limits, whichever code path asked for it — and so does waiting out a
   * browser that is closing for idleness, which is not one to open a page in.
   */
  private wrapTransport(chosen: Transport): Transport {
    return {
      name: chosen.name,
      send: async (history, opts) => {
        if (this.parking) await this.parking;
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
  }

  private async initOnce(): Promise<EngineStatus> {
    this.emitConnect("connecting");
    configureBrowser({
      headed: this.config.headed ?? false,
      persistProfile: this.config.persistProfile ?? true,
    });

    // ChatGPT's resolver, for ChatGPT only.
    //
    // `resolveAuth` reads ChatGPT's cookies, asks ChatGPT's session endpoint
    // for an access token and stores ChatGPT's session. It ran on every
    // start whatever service was selected, which is both wrong and
    // needless: a Qwen run has no use for a ChatGPT token, and holding one
    // is what let `hasSession` below report a signed-in Qwen on the strength
    // of a ChatGPT cookie.
    //
    // A browser-driven service starts with nothing, which is the truth: its
    // session lives in its own browser profile and the probe is what finds
    // it.
    this.auth = isBrowserProvider()
      ? { accessToken: "", model: "", maxIterations: 0, cookies: [], sessionToken: "" }
      : await resolveAuth();
    const choice = chooseTransport(this.auth);
    this.transport = this.wrapTransport(choice.transport);
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
    this.reportSkippedInstructions();
    this.policy = createPolicy(this.cwd, this.approvalMode, {
      commands: this.config.allowedCommands,
      writeDirs: this.config.allowedWriteDirs,
      bashRules: this.config.bashRules as BashRules | undefined,
    });
    // createPolicy drops stored entries that are not commands, but only in
    // memory - so an install carrying junk stayed ugly on disk until some
    // later approval happened to write the list back. Written out here
    // instead, and only when something was actually dropped, so the file
    // heals on the next launch rather than on the next "always allow".
    const storedCommands = this.config.allowedCommands ?? [];
    if (storedCommands.length !== this.policy.allowedCommands.size) {
      const dropped = storedCommands.filter((c) => !this.policy.allowedCommands.has(c));
      logger.warn("engine", "dropped stored allowlist entries that are not commands", { dropped });
      saveConfig({ allowedCommands: [...this.policy.allowedCommands] });
      this.config = loadConfig();
    }

    const restored = this.adoptableSession(this.cwd);
    if (restored) {
      this.adoptStoredSession(restored);
    } else {
      this.session = createSession(this.cwd, this.model);
      this.history = this.session.messages;
      this.archived = this.session.archived ?? [];
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
    this.startIdleClock();
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
    //
    // And asked every start, not only when nothing is stored. The stored
    // value is a cache of something the service owns, and a stale one is
    // expensive in a way nothing on screen explains: a config still saying
    // "free" on a Pro Lite account is compacted at 4,000 characters instead
    // of 40,000 - measured, ten times smaller - so it summarises itself
    // almost every turn, and every summary opens a fresh conversation and
    // replays the transcript into it. Found on a live install, where the
    // config said free and the account's own token said prolite.
    {
      try {
        const plan = await fetchAccountPlan(this.auth.cookies);
        // Null is "this service has no plans to report" (DeepSeek) or a
        // request that did not land - neither is a reason to forget a good
        // stored value.
        if (plan && plan !== cfg.planType) {
          const was = cfg.planType;
          saveConfig({ planType: plan });
          this.config = loadConfig();
          if (was) {
            logger.warn("engine", "the stored plan was out of date", {
              was,
              now: plan,
              budgetWas: compactionBudget(was, false, null, this.systemPromptChars()),
              budgetNow: compactionBudget(plan, false, null, this.systemPromptChars()),
            });
            this.notice(
              `Your plan reads as ${describePlan(plan) ?? plan}, but OnFlip had "${was}" stored and was sizing the conversation from it. Corrected — long chats will now keep more before summarising.`
            );
          }
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
    // A browser-driven service is always probed. Its transport is also named "browser", and
    // the cookies in hand are ChatGPT's — so the shortcut below would read a
    // ChatGPT session as proof that DeepSeek is connected, and report a
    // signed-out account as ready. Reported from the field on the first
    // switch: "it says connected, but I have not signed in to DeepSeek".
    const onBrowserService = isBrowserProvider();
    if (!onBrowserService && (this.transport.name !== "browser" || this.auth.cookies.length > 0)) {
      this.emitConnect("ready");
      return;
    }
    try {
      const state = await checkSignedIn(this.auth.cookies);
      this.probeSignedIn = state.signedIn;
      // A cached name over a signed-out session is an identity for an
      // account nobody is using. The cache exists so the sidebar is not
      // blank while the probe runs - once the probe has answered, it has
      // nothing left to say. Seen on the first Qwen launch: a real name
      // and email in the account bar, directly under a red banner saying
      // the app was not signed in to Qwen.
      if (!state.signedIn) this.account = null;
      this.pushStatus();
      if (state.signedIn) {
        this.emitConnect("ready");
        this.startSessionWatch();
        this.offerUnsentPrompt();
        return;
      }
      // Point at the button in this app, not at a terminal command: a
      // desktop user on a fresh machine has no CLI, and when the cookie
      // reader could not run at all, saying "no session found" would blame
      // the account for a missing runtime.
      const why = takeExtractError();
      const service = providerLabel();
      this.offerUnsentPrompt();
      this.emitConnect(
        "signed-out",
        state.reachable
          ? `OnFlip is not signed in to ${service} — open the account menu (bottom left) and choose "Sign in".${why && !onBrowserService ? ` (${why})` : ""}`
          : `${service} could not be reached (${state.detail}).`
      );
    } catch (e) {
      this.emitConnect("error", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Keep an eye on the session while nothing else is happening.
   *
   * It used to be looked at once, at startup, and then only when a turn
   * failed. For a browser-driven service that is the wrong shape: a Qwen
   * session was measured dying in about three and a half hours with the app
   * sitting open, and the way anybody found out was to write a message, send
   * it, wait, and be told afterwards. The banner said "connected" the whole
   * time.
   *
   * So it is asked again, quietly. What makes that affordable is that the
   * driver keeps its browser context between calls — the check after startup
   * is a page evaluate and one request to the service, not a browser launch —
   * and it is the same request the service already answers definitively.
   *
   * Three rules keep it from becoming a nuisance:
   *
   *   Only when idle. A check during a turn would read a page mid-answer,
   *   and the turn is about to find out for itself anyway.
   *
   *   Only a definite answer counts. "Could not look" changes nothing, which
   *   is the rule everywhere else in this app and the reason it is here too:
   *   being wrong in that direction sends somebody to a sign-in that cannot
   *   help.
   *
   *   Only on a change. Re-emitting "still signed in" every few minutes would
   *   put a banner in front of somebody for no reason.
   */
  private startSessionWatch(): void {
    if (!isBrowserProvider()) return;
    this.watching = true;
    this.startIdleClock();
  }

  /**
   * The clock the watch runs on, which also parks an idle browser.
   *
   * Started with the engine rather than with the watch: a browser opened by
   * a sign-in probe that found no session still runs, and is exactly as
   * worth closing when nobody is using the app. See `idle.ts`.
   */
  private startIdleClock(): void {
    if (this.sessionWatch || !isBrowserProvider()) return;
    this.sessionWatch = setInterval(() => {
      void this.idleTick();
    }, SESSION_WATCH_MS);
    // Never hold the process open on its own account.
    this.sessionWatch.unref?.();
  }

  private stopSessionWatch(): void {
    this.watching = false;
    if (!this.sessionWatch) return;
    clearInterval(this.sessionWatch);
    this.sessionWatch = null;
  }

  private async idleTick(): Promise<void> {
    const step = idleStep(Date.now() - this.lastActiveAt, {
      busy: this.busy,
      watching: this.watching,
      parked: this.parked,
    });
    if (step === "park") await this.parkBrowser();
    else if (step === "check") await this.checkSessionQuietly();
  }

  /** Something was asked of the app: it is in use, whatever it is doing. */
  private noteActive(): void {
    this.lastActiveAt = Date.now();
  }

  /**
   * Close the service's browser until it is needed again.
   *
   * The driver forgets the live conversation as it closes, so the next send
   * carries the whole transcript into a new one — the same recovery as
   * after Stop, and the reason this waits two hours rather than one.
   */
  private async parkBrowser(): Promise<void> {
    if (this.busy || this.parked || this.parking || this.watchInFlight) return;
    this.parked = true;
    logger.info("session", "idle: closing the service's browser until it is needed", {
      provider: activeProvider(),
      idleMinutes: Math.round((Date.now() - this.lastActiveAt) / 60_000),
    });
    this.parking = closeBrowser()
      .catch(() => {})
      .finally(() => {
        this.parking = null;
      });
    await this.parking;
  }

  /**
   * The window came to the front.
   *
   * Counts as use, and after a quiet spell looks at the session at once —
   * which also reopens a parked browser while the person is still reading,
   * so their next message does not wait for it.
   */
  wake(): null {
    const look = lookOnWake(Date.now() - this.lastCheckAt, {
      busy: this.busy,
      watching: this.watching,
      parked: this.parked,
    });
    this.noteActive();
    if (look) void this.checkSessionQuietly();
    return null;
  }

  private async checkSessionQuietly(): Promise<void> {
    if (this.busy || this.watchInFlight) return;
    this.watchInFlight = true;
    try {
      if (this.parking) {
        await this.parking;
        // A turn that started meanwhile will find out for itself.
        if (this.busy) return;
      }
      // The check opens the browser again if it was parked.
      this.parked = false;
      this.lastCheckAt = Date.now();
      const state = await checkSignedIn(this.auth.cookies);
      // The rule lives in `watchVerdict`, pure and tested: unreachable
      // changes nothing, and neither does an answer that agrees with what is
      // already on screen.
      const verdict = watchVerdict(state, this.probeSignedIn);
      if (verdict === "ignore") return;

      this.probeSignedIn = verdict === "signed-in";
      if (verdict === "signed-in") {
        logger.info("session", "the session came back", { provider: activeProvider() });
        this.emitConnect("ready");
      } else {
        // The whole point: said before the next message is written, not
        // after it has been sent into a page that cannot answer.
        this.account = null;
        logger.info("session", "the session has gone", { provider: activeProvider() });
        this.emitConnect(
          "signed-out",
          sessionEndedNotice(providerLabel(), activeProvider())
        );
      }
      this.pushStatus();
    } catch {
      // A watchdog that can break the app is worse than no watchdog.
    } finally {
      this.watchInFlight = false;
    }
  }

  /**
   * Say when a project instruction file was found and then left out.
   *
   * Instructions are re-sent with every turn and come off the transcript
   * budget before it is divided, so the size cap earns its keep - but it used
   * to skip in silence, which is the part that costs. OnFlip working in its
   * own tree is the example: AGENTS.md is 89 KB against a 32 KB cap, so the
   * most useful document in the repository was dropped from every prompt and
   * nothing said so. The fix a person can act on is to split the file, and
   * they can only act on it once told.
   */
  private reportSkippedInstructions(): void {
    const skipped = this.context?.instructionsSkipped ?? [];
    if (skipped.length === 0) return;
    logger.warn("engine", "instruction files were too large to load", { skipped });
    for (const { file, bytes, reason } of skipped) {
      const kb = (n: number) => `${Math.round(n / 1000)}KB`;
      this.notice(
        reason === "total"
          ? `${file} (${kb(bytes)}) was not loaded: with the instruction files nearer this folder it would pass the ${kb(MAX_INSTRUCTION_TOTAL_BYTES)} limit for all instruction files together. Instructions are re-sent every turn and come out of the conversation budget — shorten or merge them to have it read.`
          : `${file} is ${kb(bytes)}, over the ${kb(MAX_INSTRUCTION_BYTES)} limit for instruction files, so it was not loaded. Instructions are re-sent every turn and come out of the conversation budget — split it into smaller files to have it read.`
      );
    }
  }

  private emitConnect(state: "connecting" | "ready" | "signed-out" | "error", detail?: string) {
    this.peer.emit("connect", { state, detail });
  }

  /**
   * Hand back a message that was typed, sent, and never delivered.
   *
   * Offered once, into the composer, and cleared the moment it is offered —
   * whether or not anybody uses it. Leaving it on disk would mean it
   * reappearing at every start until somebody happened to send it.
   *
   * Never sent on its own. A prompt that fires by itself after a restart is
   * worse than a lost one: losing it costs thirty seconds of retyping, and
   * sending it unbidden spends a turn nobody asked for, against whichever
   * service and folder happen to be current now.
   */
  private offerUnsentPrompt(): void {
    const text = unsentPromptToRestore(loadConfig().unsentPrompt);
    if (!text) return;
    saveConfig({ unsentPrompt: undefined });
    this.peer.emit("draft", { text });
    logger.info("session", "offered back a message that was never delivered");
  }

  private adoptStoredSession(restored: StoredSession): void {
    this.session = restored;
    this.history = restored.messages;
    this.archived = restored.archived ?? [];
    this.toolState = createSessionState();
    this.toolState.todos = restored.todos ?? [];
    this.toolState.snapshots = restored.snapshots ?? [];
    // A session remembers the model it ran on, and a model belongs to a
    // service. Adopting it unconditionally is how DeepSeek ended up
    // reporting a gpt slug: sessions written before the provider scoping
    // was tightened can carry one in DeepSeek's own folder, and opening one
    // pinned the run to a model this service has never heard of. The chip
    // then showed that slug - the picker has no label for it, so it falls
    // back to the raw text - while the transport quietly ran its default,
    // so the label was not just wrong, it disagreed with what was running.
    // Mended here rather than saved: a save on open would bump the session
    // up the sidebar, and opening a session must never move it.
    // Normalised first: a session saved before 14 September 2026 can name
    // a DeepSeek mode that no longer exists, and it belongs to this
    // service - so it passes the check below and would pin the run to a
    // slug the picker has no label for.
    const restoredModel = restored.model ? normalizeModel(restored.model) : undefined;
    if (restoredModel && modelBelongsToProvider(restoredModel)) {
      this.model = restoredModel;
      restored.model = restoredModel;
    } else if (restored.model) {
      logger.warn("session", "stored model belongs to another service; keeping this one", {
        stored: restored.model,
        using: this.model,
      });
      restored.model = this.model;
    }
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
      // The prompt says different things to different services: only
      // ChatGPT has drawings OnFlip can carry into the folder, and only
      // ChatGPT has its own agent products to refuse by name.
      provider: activeProvider(),
    });
    if (this.history[0]?.role === "system") this.history[0].content = prompt;
    else this.history.unshift(newMessage("system", prompt));
  }

  private buildTools() {
    return createToolRegistry({
      // Absent rather than refusing when it is off: a tool the model can
      // call and nothing can carry out is worse than no tool. Off unless
      // switched on — a sub-agent abandons the live thread and burns the
      // provider's allowance on a second conversation, which is a cost
      // somebody should choose, not inherit.
      runSubAgent: loadConfig().subAgents === true ? (req) => this.runSubAgent(req) : undefined,
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
      // The bot lives in the app, not in here, so the tool asks the app to
      // carry the file and waits for a real answer — "Telegram refused it"
      // is something the model has to hear. "The bot is off" it no longer
      // hears, because with no bot the tool is not offered at all.
      deliverFile: this.deliverable
        ? (file, caption) =>
            this.peer.request<{ ok: boolean; detail: string }>("telegram-file", {
              file,
              caption,
            })
        : undefined,
    });
  }

  /**
   * Is there anywhere for `send_file` to send a file?
   *
   * False until the app says otherwise, which it does on every init and
   * whenever the Telegram settings change. Defaulting to false is the
   * safe direction: most installs have no bot, and offering a tool that
   * cannot work costs a round trip to find out plus its documentation in
   * every conversation.
   */
  setDeliverable(available: boolean): null {
    if (this.deliverable === available) return null;
    this.deliverable = available;
    // Reseed so the next conversation documents the right roster, and
    // deliberately no transport.reset(): the live chat already holds the
    // old prompt, and opening a fresh one to correct a single tool would
    // cost far more than the tool is worth.
    this.seedSystemPrompt();
    return null;
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

  /**
   * Where the compaction budget came from, for the meter to say out loud.
   *
   * Mirrors contextBudgetChars step for step. A number with no provenance
   * cannot be sanity-checked by the person looking at it - which is how a
   * config still claiming the Free plan sized the transcript at a tenth of
   * what the account was entitled to, with the meter dutifully reporting a
   * full bar every turn and nobody able to tell why.
   */
  private contextBudgetSource(): string {
    if (this.config.compactAfterChars) return "your own setting";
    if (isBrowserProvider()) return `${providerLabel()}'s own limit`;
    // With turns typed rather than uploaded, what one message can carry is
    // usually the binding limit and the plan only matters when it is
    // smaller - which is exactly the case worth naming.
    if (this.contextBudgetChars() >= COMPOSER_CEILING_CHARS) {
      return "what one message can carry";
    }
    const described = describePlan(loadConfig().planType);
    const plan = described ? described.split(" \u00b7")[0] : null;
    return plan ? `your ${plan} plan` : "the default for an unread plan";
  }
  private contextBudgetChars(): number {
    // An explicit setting wins; otherwise the model's published window,
    // then the plan, size the budget — 45k on a million-token Sol was
    // compacting every few turns of real work. The prompt's own size goes
    // in because the send carries it too: budgeting the transcript alone
    // is how a Free account ended up sending more than its window holds.
    // DeepSeek's ceiling is its own, and it is not the composer's: measured,
    // 80,069 characters arrived in one send and were read to the end.
    if (!this.config.compactAfterChars && isBrowserProvider()) {
      // A table, not a chain with a fallback. The chain read "qwen, else
      // DeepSeek", so a fourth provider silently inherited DeepSeek's
      // 150,000 - a number measured on DeepSeek and on nothing else.
      const ceilings: Record<string, number> = {
        qwen: QWEN_CEILING_CHARS,
        deepseek: DEEPSEEK_CEILING_CHARS,
      };
      return ceilings[activeProvider()] ?? COMPOSER_CEILING_CHARS;
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

  /** Tell the window the sub-task list has moved on. */
  private pushSubTasks(): void {
    this.peer.emit("sub-tasks", { subTasks: this.subTasks });
  }

  /** Everything this session has handed to a sub-agent, oldest first. */
  listSubTasks(): SubTaskDTO[] {
    return this.subTasks;
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
      contextBudgetSource: this.contextBudgetSource(),
      // Less room for the conversation than for the instructions that
      // precede it means compacting almost every turn, and every
      // compaction opens a fresh chat and replays everything into it.
      contextCrowded:
        this.systemPromptChars() > 0 && this.contextBudgetChars() < this.systemPromptChars(),
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
      approvalModes: availableModes(),
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
    // The rule itself is in `reportsSignedIn`, pure and tested. Inline, it
    // counted ChatGPT's cookies for every service and reported a signed-out
    // Qwen as signed in.
    return reportsSignedIn({
      signedOut: Boolean(loadConfig().signedOut),
      browserProvider: isBrowserProvider(),
      hasCookies: Boolean(this.auth?.cookies.length),
      hasStoredToken: Boolean(loadConfig().sessionToken),
      probe: this.probeSignedIn,
    });
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
      rememberScope: this.rememberScope(req),
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

  /**
   * What the "always allow" control says, and what it is promising.
   *
   * These were one string, and the button carried the whole promise:
   * `Always allow "<the command>"`. That read well while a remembered
   * command was a short prefix like `python`. It does not any more — a
   * grant is exact since the audit, so the key is the entire command — and
   * a heredoc writing a source file turned the button into a wall of code
   * with the word "Always" somewhere near the top of it.
   *
   * So the label is the promise and the scope is the thing promised, and
   * the window puts them in different places. The scope is still shown
   * rather than dropped: an exact grant is the whole point of that change,
   * and a button reading "Always allow" without saying allow *what* is a
   * control people click and then cannot account for afterwards.
   */
  private rememberLabel(req: PermissionRequest): string | undefined {
    if (req.kind === "command") return commandKey(req.subject) ? "Always allow" : undefined;
    if (req.kind === "write" && req.targetPath) {
      // An instruction file is asked about every time, remembered folder or
      // not (`isInstructionFile`), so a control promising "always" would be
      // a promise the next write breaks.
      if (isInstructionFile(req.targetPath)) return undefined;
      // A drive root or the home folder is never remembered, so the control
      // is not offered for one: see `rememberableWriteDir`.
      const dir = rememberableWriteDir(req.targetPath);
      if (!dir) return undefined;
      const rel = path.relative(this.cwd, dir).replace(/\\/g, "/") || ".";
      return `Always allow writes in ${rel}`;
    }
    return undefined;
  }

  /**
   * Exactly what a remembered grant would cover, when that is not already
   * obvious from the command shown above it.
   *
   * For `npm test` the key and the command are the same string, and
   * printing it twice under a heading is noise. They diverge exactly where
   * it matters: a heredoc writing a file is many lines on screen and one
   * normalised line in the allowlist, so what gets remembered is the whole
   * thing — body included — and will therefore almost never match again.
   * That is worth seeing before agreeing to it.
   */
  private rememberScope(req: PermissionRequest): string | undefined {
    if (req.kind !== "command") return undefined;
    const key = commandKey(req.subject);
    if (!key || key === (req.subject ?? "").trim()) return undefined;
    return key;
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

  send(text: string, attachments?: string[], origin?: "telegram"): { queued: boolean } {
    if (!this.connected) throw new Error("The engine is still connecting — try again in a moment.");
    this.autoResumes = 0;
    // A switch waiting on the browser holds sends the way a turn does: see
    // `holdingSends`.
    if (this.busy || this.switching) {
      // A queued message keeps its own attachments: they belong to that
      // message, not to whichever turn happens to run next.
      this.queue.push({ id: randomUUID(), text, attachments, origin });
      this.pushStatus();
      return { queued: true };
    }
    void this.runOneTurn(text, attachments, origin);
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
    // First in the queue: it resumes the work that was stuck, and anything the
    // person queued behind that work was meant to follow it, not jump it.
    this.queue.unshift({ id: randomUUID(), text: RESUME_PROMPT, auto: true });
    this.abort.abort();
    // An abort is only seen by a loop that comes back to look, and the hang
    // this exists for is a `page.evaluate` that never returns — the case
    // `FORCE_STOP_MS` documents. Without the force stop the restart was a
    // notice and a queued word behind a turn that stayed wedged.
    this.armForceStop();
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
    // Whether or not this press was the one that aborted: the turn is still
    // running, and stop has to end it even when nothing is watching.
    if (this.busy) this.armForceStop();
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

  /** Set between a stop being pressed and the turn actually ending. */
  private forceStop: NodeJS.Timeout | null = null;

  private armForceStop(): void {
    if (this.forceStop) return;
    this.forceStop = setTimeout(() => {
      this.forceStop = null;
      if (!this.busy) return;
      logger.warn("session", "stop did not land; closing the browser to end the turn");
      this.notice(
        "The page stopped responding, so OnFlip closed its browser to end the turn. The next message opens it again."
      );
      void closeBrowser().catch(() => {});
    }, FORCE_STOP_MS);
  }

  private clearForceStop(): void {
    if (!this.forceStop) return;
    clearTimeout(this.forceStop);
    this.forceStop = null;
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

  private async runOneTurn(
    text: string,
    attachments?: string[],
    origin?: "telegram"
  ): Promise<void> {
    // Read by `agentOptions` when the turn's reminder is built, and held for
    // the turn rather than passed down: the loop asks for its options once
    // per turn, and a queued turn from the phone must still read as one.
    this.turnOrigin = origin;
    this.busy = true;
    this.noteActive();
    // The turn opens the browser again, if idleness had closed it.
    this.parked = false;
    this.abort = new AbortController();
    this.silence.start();
    this.toolIds.clear();
    this.pushStatus();
    // What the workspace held before the turn, so its deliverables can be
    // picked out by diff afterwards.
    const scratchBefore = inScratch(this.cwd) ? scratchIndex(this.cwd) : null;
    // The chats this process had already seen, so only the ones this turn
    // opened are credited to this session: see `recordableChatIds`.
    const chatsBefore = new Set(openedConversationIds());
    this.peer.emit("turn", { state: "start" });

    // @skill tags expand into their full prompt for the model; the emitted
    // item keeps the compact tag, which the chat renders as a link.
    const userMessage = newMessage("user", expandMentions(expandSkillToken(text), this.cwd));
    // Kept on the message as paths, which the text below only names: an
    // edit or a resend needs the files themselves to attach again.
    if (attachments?.length) userMessage.attachments = [...attachments];
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
        // More iterations than the budget means the turn earned its one
        // mid-work extension and used that up too — say so, or "60 of 40"
        // reads like a counting bug.
        const extended = result.iterations > this.maxIterations;
        this.peer.emit("turn", {
          state: "end",
          exhausted: true,
          iterations: result.iterations,
          error: extended
            ? `Stopped after ${result.iterations} steps — the ${this.maxIterations}-step budget plus one mid-work extension — without finishing. Say "continue" to keep going, or raise the step budget in Settings.`
            : `Stopped after ${result.iterations} of ${this.maxIterations} steps without finishing. Say "continue" to keep going, or raise the step budget in Settings.`,
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
      // A turn that failed for want of a session is the most direct evidence
      // there is that the account bar is wrong, so the bar is corrected from
      // it rather than left saying "connected" until something re-probes.
      //
      // It matters most on a service whose session can lapse while the page
      // still looks perfectly normal: Qwen shows a working composer, no
      // sign-in controls and a valid-looking token right up until a send is
      // attempted, so nothing before the send can know — and without this the
      // app would go on claiming a connection through every failed turn.
      // The words survive the failure. A session that has gone usually means
      // a sign-in or a switch to another service, and a switch relaunches the
      // app - so without this the message is gone and has to be retyped from
      // the transcript. Saved, not re-sent: see `unsentPrompt`.
      if (code === "signed-out" && text.trim()) {
        saveConfig({ unsentPrompt: { text: text.slice(0, 20_000), at: Date.now() } });
      }
      if (code === "signed-out" && this.probeSignedIn !== false) {
        this.probeSignedIn = false;
        this.account = null;
        this.emitConnect("signed-out", message);
        this.pushStatus();
      }
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
      this.clearForceStop();
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
        this.session.chatIds = recordableChatIds(
          this.session.chatIds ?? [],
          [currentConversationId(), ...openedConversationIds()],
          chatsBefore,
          this.session.chatId
        );
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
      // Idleness is counted from the end of the work, not its start: a
      // two-hour turn is not two hours of nobody using the app.
      this.noteActive();
      this.saveNow();
      this.pushStatus();
      this.maybeAdoptChatTitle();
      this.maybeIdentifyAccount();

      if (next !== undefined) {
        // Start synchronously through the point where runOneTurn installs its
        // new AbortController. A stop click can then never hit the old turn's
        // already-finished controller during the queue hand-off.
        void this.runOneTurn(next.text, next.attachments, next.origin);
      }
    }
  }

  private accountFetchInFlight = false;
  /** Whether this run has read the account from the service itself. */
  private accountVerified = false;

  /**
   * Identify the account through the page when the Node-side session read
   * could not — Cloudflare blocks that one for some machines. Runs after a
   * turn, when the browser is already warm, and only until it succeeds.
   */
  private maybeIdentifyAccount(): void {
    // Once a run, not once ever. The cached name is shown immediately so the
    // sidebar is not blank, but it is only a cache - and a wrong one survived
    // for good, because this used to stop the moment an account existed. A
    // ChatGPT name written into DeepSeek's room by an older build therefore
    // stayed on screen through every restart, on the service it did not
    // belong to. Verifying once a turn-end costs nothing here: the browser is
    // already open by then.
    if (this.accountFetchInFlight || this.accountVerified) return;
    if (!this.transport || this.transport.name !== "browser") return;
    this.accountFetchInFlight = true;
    setTimeout(() => {
      void (async () => {
        try {
          if (this.busy) return;
          const user = await pageSessionUser(this.auth.cookies);
          // An answer, even an empty one, settles it for this run: a service
          // that has no name to give would otherwise be asked again at the
          // end of every turn. A throw leaves it unset, so a genuinely
          // transient failure still gets another go.
          this.accountVerified = true;
          if (!user) return;
          const changed = user.name !== this.account?.name || user.email !== this.account?.email;
          this.account = user;
          if (changed) saveConfig({ accountName: user.name, accountEmail: user.email });
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

  /**
   * Run a self-contained piece of work in a conversation of its own.
   *
   * The point is what does NOT come back. A sub-agent that reads thirty
   * files returns a paragraph; those thirty files never enter the parent's
   * transcript, and tool output is - measured, on this machine's own logs -
   * most of what fills a transcript and forces the summarising that costs a
   * request, a fresh chat and a full replay.
   *
   * The cost is a conversation. OnFlip drives one chat at a time, so the
   * child takes a new one and the parent's is abandoned: the parent's next
   * message replays its transcript into a fresh thread. That is about what
   * one compaction costs, which is why the tool's own description tells the
   * model not to spend it on a single file read.
   *
   * Two things the child deliberately does not get. It has no `task` tool,
   * so a sub-agent cannot spawn sub-agents - the cost above would compound
   * with nothing watching. And it has no memory of this conversation, which
   * is the whole reason its reading stays out of ours; the prompt has to
   * stand on its own, and the tool says so.
   */
  private async runSubAgent(req: SubAgentRequest): Promise<SubAgentResult> {
    // Its own tool state: a sub-agent's todo list and approvals are its
    // own, and must not be mixed into the parent's.
    const childSession = createSessionState();
    const registry = createToolRegistry({
      cwd: this.cwd,
      session: childSession,
      signal: req.signal,
      requestPermission: (r) => this.requestPermission(r),
      readOnly: this.approvalMode === "read-only",
      disableShell: !this.shellEnabled || this.approvalMode === "read-only",
      disableNetwork: !this.networkEnabled,
      // No `task`: one level, on purpose.
      // Its output is the turn's sign of life too. Without this the silence
      // watchdog saw nothing while a sub-agent ran a test suite: a false
      // "nothing has come back" at 150 seconds, and at 420 the work killed
      // and restarted, up to three times.
      onProgress: () => this.markActivity(),
    });

    const history: ChatMessage[] = [
      newMessage(
        "system",
        buildSystemPrompt({
          tools: registry.list,
          context: this.context,
          approvalMode: this.approvalMode,
          shellEnabled: this.shellEnabled && this.approvalMode !== "read-only",
          provider: activeProvider(),
        })
      ),
      newMessage("user", req.prompt),
    ];

    const parent = this.agentOptions();
    // A budget of its own, and smaller: a sub-agent that needs a hundred
    // steps is not a sub-task, it is the whole job in the wrong place.
    const budget = Math.max(5, Math.min(25, this.maxIterations));

    // The record the sub-task panel reads. Kept here rather than in the
    // transcript on purpose: a sub-agent's tool calls are exactly what the
    // parent conversation is meant not to carry, and the reason to hand work
    // to one at all. Out of the transcript should not have meant out of
    // sight, which is what it did mean until now.
    const record: SubTaskDTO = {
      id: randomUUID(),
      description: req.description,
      status: "running",
      startedAt: Date.now(),
      steps: 0,
      budget,
      activity: [],
    };
    this.subTasks.push(record);
    this.pushSubTasks();

    this.notice(`Working on a sub-task: ${req.description}`);
    // The child's chat is its own. The parent's is abandoned here rather
    // than after, so an interrupt mid-sub-task cannot leave the parent
    // pointing at the child's thread.
    this.transport.reset();
    try {
      const result = await runTurn(history, {
        ...parent,
        tools: registry,
        session: childSession,
        maxIterations: budget,
        signal: req.signal,
        events: {
          // Its steps belong to it. What reaches the user is that something
          // is happening and, at the end, the answer - not thirty tool
          // cards from a conversation they are not in.
          onNotice: (text) => {
            this.markActivity();
            req.onProgress?.(text);
          },
          onDelta: () => this.markActivity(),
          onNarration: () => this.markActivity(),
          onToolStart: () => this.markActivity(),
          onThinking: (iteration) => {
            this.markActivity();
            record.steps = iteration;
            this.pushSubTasks();
            req.onProgress?.(`${req.description}: step ${iteration}`);
          },
          // What it did, as it does it. Capped, because this is a summary
          // somebody reads to follow the work - a sub-agent that ran fifty
          // greps needs to say so, not list them.
          onToolEnd: (call, toolResult) => {
            this.markActivity();
            if (record.activity.length < SUB_TASK_ACTIVITY_MAX) {
              record.activity.push({
                tool: call.tool,
                subject: subjectFor(call.tool, call.arguments),
                ok: !toolResult.error,
              });
              this.pushSubTasks();
            }
          },
        },
      });
      const stopped = result.interrupted
        ? "it was interrupted"
        : result.exhausted
          ? `it ran out of steps (${budget})`
          : undefined;
      record.status = result.interrupted ? "stopped" : "done";
      record.steps = result.iterations;
      record.answer = result.finalAnswer;
      record.stopped = stopped;
      record.endedAt = Date.now();
      this.pushSubTasks();
      return { answer: result.finalAnswer, steps: result.iterations, stopped };
    } catch (e) {
      record.status = "failed";
      record.stopped = e instanceof Error ? e.message : String(e);
      record.endedAt = Date.now();
      this.pushSubTasks();
      throw e;
    } finally {
      // Back to a clean thread for the parent, whatever happened. Its next
      // send replays the transcript, which is the cost this tool is named
      // for in its own description.
      this.transport.reset();
    }
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
      remote: this.turnOrigin === "telegram",
      // Where the session's own edits are, so they can be named relative to
      // the project in the reminder and restored after a compaction.
      cwd: this.cwd,
      // A backstop only; the character budget below is what decides. See the
      // constant for what 60 used to cost.
      compactAfterMessages: this.config.compactAfter ?? COMPACT_AFTER_MESSAGES_BACKSTOP,
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
            // Masked for the screen; the approval preview reads pendingArgs.
            args: displayArgs(call.tool, call.arguments),
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
    if (!this.saveNow()) throw new Error("The current session could not be saved. Try again before leaving it.");
    this.releaseHeldSession();
    this.session = createSession(this.cwd, this.model);
    this.history = this.session.messages;
    this.archived = this.session.archived ?? [];
    this.toolState = createSessionState();
    // A `cd` from the last session must not decide where this one's first
    // command runs. The shell's directory is process-wide, and only a change
    // of project folder used to reset it: after /new, `rm -rf build` ran in
    // the old session's subfolder while the prompt told the model it was at
    // the project root.
    resetShellCwd();
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

  resumeSession(id: string): Promise<EngineStatus> {
    return this.holdingSends(() => this.doResumeSession(id));
  }

  private async doResumeSession(id: string): Promise<EngineStatus> {
    let restored = loadSession(id);
    if (!restored) throw new Error("That session could not be read.");
    if (!this.saveNow()) throw new Error("The current session could not be saved. Try again before leaving it.");
    if (restored.id !== this.session?.id) {
      const previousId = this.session?.id;
      if (!this.holdSession(restored.id)) {
        throw new Error("That session is open in another OnFlip window.");
      }
      // The other engine may have made one final save between the first read
      // and releasing its lock. Read only after ownership is ours.
      const locked = loadSession(restored.id);
      if (!locked) {
        this.releaseHeldSession();
        if (previousId) this.holdSession(previousId);
        throw new Error("That session could not be read.");
      }
      restored = locked;
    }

    // A session belongs to a directory; follow it there if it still exists.
    if (path.resolve(restored.cwd) !== path.resolve(this.cwd) && fs.existsSync(restored.cwd)) {
      this.relocate(restored.cwd);
    } else {
      // Same folder, different session: its `cd`s are not this one's.
      resetShellCwd();
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
  signInWithBrowser(): Promise<{ ok: boolean; reason?: string; browser?: string }> {
    // The sign-in browser holds OnFlip's profile for as long as it is open,
    // and a send meanwhile would launch the automation browser on it.
    return this.holdingSends(() => this.doSignInWithBrowser());
  }

  private async doSignInWithBrowser(): Promise<{ ok: boolean; reason?: string; browser?: string }> {
    const result = await signInWithRealBrowser((state) => this.peer.emit("sign-in", { state }));
    // `browser` is ChatGPT's flow naming which browser it opened; DeepSeek's
    // succeeds without one. Requiring it here turned every successful
    // DeepSeek sign-in into a silent failure — ok:false with no reason, the
    // modal dropping back to idle as though nothing had happened — on every
    // platform, while the session sat in the profile the whole time.
    if (!result.ok) return { ok: false, reason: result.reason };

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
      ...(result.browser ? { browserChannel: result.browser.channel } : {}),
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
      `Signed in to ${providerLabel()}${result.browser ? ` with ${result.browser.name}` : ""}. The session lives in OnFlip's own browser profile and is kept between launches.`
    );
    this.pushStatus();
    return { ok: true, browser: result.browser?.name };
  }

  finishBrowserSignIn(): boolean {
    return finishRealBrowserSignIn();
  }

  cancelBrowserSignIn(): boolean {
    return cancelRealBrowserSignIn();
  }

  removeSession(id: string): { ok: boolean } {
    if (this.session?.id === id) throw new Error("That session is currently open.");
    // Open in another window, it is that window's: its next save would bring
    // the file straight back, and the chats deleted below would be the ones
    // it is still talking in.
    if (sessionHeldElsewhere(id)) throw new Error("That session is open in another window. Close it there first.");
    // Read the record before the file goes: it names the conversations this
    // session opened on chatgpt.com, which should not outlive it. Attached
    // chats (`chatId`) are the user's own and are left alone.
    const stored = loadSession(id);
    const ok = deleteSession(id);
    // Never the attached chat, even if an older build recorded it among the
    // session's own: deleting the session must not delete the user's chat.
    const remote = (stored?.chatIds ?? []).filter((chat) => chat !== stored?.chatId);
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

  openProject(dir: string): Promise<EngineStatus> {
    return this.holdingSends(() => this.doOpenProject(dir));
  }

  private async doOpenProject(dir: string): Promise<EngineStatus> {
    const target = resolveDir(this.cwd, dir);
    if (path.resolve(target) === path.resolve(this.cwd)) return this.statusPayload();

    if (!this.saveNow()) throw new Error("The current session could not be saved. Try again before leaving it.");
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
    // Discovery is ChatGPT's, all the way down: it asks ChatGPT's endpoint
    // through ChatGPT's browser, with ChatGPT's cookies. DeepSeek's three
    // modes are a built-in list that is never discovered, so running this
    // there does nothing useful and a great deal of harm - measured on a
    // DeepSeek start: ChatGPT's browser opened one second after DeepSeek's
    // and put 53 stored cookies into a profile. Worse, start() awaits this,
    // so a ChatGPT page that is slow or being challenged holds the whole
    // engine short of ready and every message sits at "sending".
    if (isBrowserProvider()) return allModels();
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
    // Asking for a mode this machine does not offer settles at `ask`
    // rather than failing: the caller may be the phone, an older window,
    // or a config written elsewhere, and none of them should be able to
    // turn the last check off.
    const allowed = clampApprovalMode(mode);
    if (allowed !== mode) {
      this.notice(`"${mode}" is not available on this machine, so the mode is "${allowed}".`);
    }
    this.approvalMode = allowed;
    this.policy.mode = allowed;
    saveConfig({ approvalMode: allowed });
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
      // On unless it was turned off. The pane is a feature people use;
      // the port it needs is the thing worth being able to close.
      embeddedBrowser: cfg.embeddedBrowser !== false,
      // Off by default, unlike the browser above: see buildTools.
      subAgents: cfg.subAgents === true,
      maxIterations: firstPositiveInt([cfg.maxIterations], DEFAULT_STEP_BUDGET),
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
    add(
      "cookie reader",
      process.env.ONFLIP_ELECTRON_PATH || process.versions.electron
        ? "the app's own runtime"
        : "whatever node is on PATH"
    );
    lines.push("");
    add("plan", describePlan(cfg.planType) ?? cfg.planType ?? "not read");
    add("model", `${this.model}${cfg.modelPinned ? " (pinned)" : " (default)"}`);
    add("thinking", this.thinking ?? "off");
    add("context", `${reducibleChars(this.history)} of ${this.contextBudgetChars()} chars`);
    add("transport", this.transport?.name);
    // Not about the paperclip - attaching files still works, and is gated by
    // the plan instead. This is whether a turn too large to type is handed
    // over as a file, which every plan now declines by default.
    add("large turns", uploadsAvailable() ? "sent as a file" : "typed into the composer");
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

    // The tail of the log, in the paste rather than named by it.
    //
    // Diagnosing a fault on somebody else's machine meant asking them to run
    // a shell command and send back the result — a lot to ask, easy to get
    // wrong, and a round trip for every question. These are the lines that
    // answer "what did the driver actually see", filtered through an
    // allow-list in `diagnosticLogLines` so a blob headed for an issue
    // cannot carry somebody's own words along with it.
    const tail = this.recentLogLines();
    if (tail.length) {
      lines.push("");
      lines.push(`recent activity (last ${tail.length} lines)`);
      lines.push(...tail);
    }

    return { text: lines.join("\n") };
  }

  /** The current log's tail, or nothing when it cannot be read. */
  private recentLogLines(): string[] {
    const file = logFile();
    if (!file) return [];
    try {
      return diagnosticLogLines(fs.readFileSync(file, "utf8"), [activeProvider(), "session"], 40);
    } catch {
      return [];
    }
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
      embeddedBrowser: (v) => ({ embeddedBrowser: Boolean(v) }),
      subAgents: (v) => ({ subAgents: Boolean(v) }),
      autoResume: (v) => ({ autoResume: Boolean(v) }),
      maxIterations: (v) => ({ maxIterations: firstPositiveInt([v as number], DEFAULT_STEP_BUDGET) }),
      replyTimeout: (v) => ({ replyTimeout: firstPositiveInt([v as number], 600) }),
      compactAfterChars: (v) => ({ compactAfterChars: firstPositiveInt([v as number], 45_000) }),
      allowedCommands: (v) => ({ allowedCommands: Array.isArray(v) ? v.map(String) : [] }),
      allowedWriteDirs: (v) => ({ allowedWriteDirs: Array.isArray(v) ? v.map(String) : [] }),
    };
    // Own keys only: "constructor" ran Object(value) and saved what it made.
    const patch = Object.hasOwn(allowed, key) ? allowed[key](value) : undefined;
    if (!patch) throw new Error(`Unknown setting: ${key}`);
    saveConfig(patch);
    this.config = loadConfig();
    if (key === "maxIterations") {
      this.maxIterations = firstPositiveInt([this.config.maxIterations], DEFAULT_STEP_BUDGET);
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
  rollbackMessage(messageId: string): { text: string; attachments?: string[] } {
    this.assertIdle();
    const index = this.history.findIndex((m) => m.id === messageId);
    if (index <= 0 || this.history[index].role !== "user") {
      throw new Error("That message can no longer be edited — start a new prompt instead.");
    }
    const text = stripUserNotes(this.history[index].content);
    const attachments = this.history[index].attachments;
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
    return attachments?.length ? { text, attachments: [...attachments] } : { text };
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
      // A compaction stopped part-way leaves the transcript as it was, and
      // saying it was compacted would be untrue.
      if (!this.abort.signal.aborted) {
        this.notice("Transcript compacted — earlier messages stay on screen, but are no longer sent.");
      }
      this.pushTranscript();
      return { ok: true };
    } finally {
      // Stop pressed during a compaction arms the force stop like it does
      // for a turn; left armed, it fired five seconds into whatever ran next
      // and closed the browser under that turn's send.
      this.clearForceStop();
      this.peer.emit("turn", { state: "end" });
      // A message sent while this ran was queued, and is handed on here the
      // way a finished turn hands on — left in the queue it waited for the
      // *next* message and then ran after it, out of order.
      const next = this.queue.shift();
      this.busy = next !== undefined;
      this.saveNow();
      this.pushStatus();
      if (next !== undefined) void this.runOneTurn(next.text, next.attachments, next.origin);
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

  undoPreview(): { rel: string; existedBefore: boolean; unavailable?: boolean; token: string } | null {
    const snapshot = this.toolState.snapshots[this.toolState.snapshots.length - 1];
    if (!snapshot) return null;
    const rel = path.relative(this.cwd, snapshot.path).replace(/\\/g, "/") || snapshot.path;
    return {
      rel,
      existedBefore: snapshot.before !== null,
      unavailable: !snapshotContentsAvailable(snapshot) || undefined,
      token: snapshotToken(this.toolState.snapshots)!,
    };
  }

  /** `expect` is the preview's token: the change the person confirmed. */
  undoLast(expect?: string): { ok: boolean; message: string } {
    const snapshot = this.toolState.snapshots[this.toolState.snapshots.length - 1];
    if (!snapshot) return { ok: false, message: "Nothing to undo." };
    const rel = path.relative(this.cwd, snapshot.path).replace(/\\/g, "/") || snapshot.path;
    if (expect !== undefined && expect !== snapshotToken(this.toolState.snapshots)) {
      return {
        ok: false,
        message: `Nothing was undone: another change landed while you were confirming, and the last change is now to ${rel}. Press Undo again to see it.`,
      };
    }
    if (!snapshotContentsAvailable(snapshot)) {
      return {
        ok: false,
        message: `Cannot undo ${rel}: its contents were omitted from the saved session. The file was left unchanged.`,
      };
    }
    if (!snapshotStillCurrent(snapshot)) {
      return {
        ok: false,
        message: `Cannot undo ${rel}: it changed after OnFlip's edit. The file was left unchanged.`,
      };
    }
    try {
      restoreSnapshot(snapshot);
      this.toolState.snapshots.pop();
      adoptRestoredRevision(this.toolState.snapshots, snapshot);
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

  attachChat(id: string, title?: string): Promise<EngineStatus> {
    return this.holdingSends(() => this.doAttachChat(id, title));
  }

  private async doAttachChat(id: string, title?: string): Promise<EngineStatus> {
    this.requireBrowserTransport("Continuing a ChatGPT conversation");
    const messages = await openConversation(this.auth.cookies, id);

    if (!this.saveNow()) throw new Error("The current session could not be saved. Try again before leaving it.");
    this.releaseHeldSession();
    this.session = createSession(this.cwd, this.model);
    this.session.title =
      title && !isPlaceholderTitle(title) ? title : "ChatGPT conversation";
    this.session.chatId = id;
    this.history = this.session.messages;
    this.archived = this.session.archived ?? [];
    this.toolState = createSessionState();
    resetShellCwd();
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
    if (this.switching) throw new Error("Still opening the last one — try again in a moment.");
  }

  /**
   * Set while a switch waits on the browser: resuming a session, opening a
   * project, attaching a chat, signing in.
   */
  private switching = false;

  /**
   * Run a switch, holding every send that arrives meanwhile in the queue.
   *
   * Each switch checked for a running turn once, before its first await,
   * and a Telegram message or a schedule firing inside that await started a
   * turn anyway: typing into the page while it was being taken to another
   * conversation, and — attaching a chat reads the chat before it swaps the
   * session — running on a session that was replaced under it. What
   * arrived waits, and starts on whatever the switch left open, failed or
   * not.
   */
  private async holdingSends<T>(work: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.switching = true;
    try {
      return await work();
    } finally {
      this.switching = false;
      const next = this.busy ? undefined : this.queue.shift();
      if (next !== undefined) void this.runOneTurn(next.text, next.attachments, next.origin);
    }
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
  private holdSession(id: string): boolean {
    if (id === this.heldSessionId) return true;
    if (!claimSessionLock(id)) return false;
    const previous = this.heldSessionId;
    this.heldSessionId = id;
    if (previous) releaseSessionLock(previous);
    return true;
  }

  private releaseHeldSession(): void {
    if (this.heldSessionId) releaseSessionLock(this.heldSessionId);
    this.heldSessionId = null;
  }

  /** The folder's latest session, unless another live engine is writing it. */
  private adoptableSession(cwd: string): StoredSession | null {
    const latest = latestSession(cwd);
    if (!latest) {
      this.releaseHeldSession();
      return null;
    }
    if (!this.holdSession(latest.id)) {
      logger.info("session", "latest session is open in another window; starting a new one", {
        cwd,
        session: latest.id,
      });
      this.releaseHeldSession();
      return null;
    }
    const locked = loadSession(latest.id);
    if (locked) return locked;
    this.releaseHeldSession();
    return null;
  }

  private saveNow(): boolean {
    if (!this.session) return true;
    // A session nobody spoke in is not worth a file: persisting it put an
    // "(empty session)" row in the sidebar for every launch and every project
    // switch. A chat attachment counts as content even before the first turn.
    const hasContent =
      this.session.chatId || this.history.some((m) => m.role !== "system");
    if (!hasContent) return true;
    if (!this.holdSession(this.session.id)) {
      logger.error("session", "session save refused because another engine owns its lock", {
        session: this.session.id,
      });
      return false;
    }
    const current = this.fingerprint();
    if (current === this.savedFingerprint) return true;
    this.session.messages = this.history;
    this.session.archived = this.archived;
    this.session.todos = this.toolState.todos;
    this.session.snapshots = this.toolState.snapshots;
    this.session.model = this.model;
    if (!saveSession(this.session)) {
      logger.error("session", "session could not be saved; it will be retried", {
        session: this.session.id,
      });
      return false;
    }
    this.savedFingerprint = current;
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopSessionWatch();
    this.abort.abort();
    this.saveNow();
    this.releaseHeldSession();
    killAllJobs();
    closeUsageStore();
    logger.info("session", "desktop engine ended");
    closeLog();
    await closeBrowser();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
