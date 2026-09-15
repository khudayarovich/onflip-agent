import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// log.ts imports `configDir` from here, so this is a cycle. It is safe because
// neither side touches the other at load time — the logger is only called
// from inside functions, by which point both modules are complete.
import { logger } from "./log";

export interface OnFlipConfig {
  // -- auth ---------------------------------------------------------------
  sessionToken?: string;
  sessionCookieName?: string;
  /**
   * The whole session jar, when OnFlip signed in itself.
   *
   * One cookie is not always the session: ChatGPT splits the token across
   * `…session-token.0` and `.1` when it is large, and restoring only the
   * first chunk restores nothing. Kept alongside the single token, which
   * stays for compatibility with sessions stored by older versions.
   */
  sessionCookies?: { name: string; value: string }[];
  /**
   * The jar above is a session the user just asked for, and must be injected.
   *
   * Normally the browser profile owns the session and the stored jar is only
   * a fallback — the profile's copy is the one the server keeps rotating,
   * and overwriting it with an older import is what used to sign a working
   * session out mid-run. A sign-in or an explicit "use my Firefox session"
   * is the exception: there the user is telling OnFlip which session to use,
   * so it goes into the profile whatever the profile already holds. Cleared
   * as soon as it has been applied.
   */
  sessionCookiesPending?: boolean;
  /**
   * Open every new chat as a ChatGPT Temporary Chat. On unless set to false.
   *
   * An agent turns one request into dozens of messages, and each lost live
   * thread starts another chat — so an afternoon's work used to leave dozens
   * of conversations in the account's sidebar. Filing them into an "OnFlip"
   * project moved the clutter rather than removing it. A Temporary Chat never
   * enters the history, the sidebar or the account's memory at all.
   *
   * Off is for anyone who wants to read the raw threads in ChatGPT
   * afterwards; OnFlip's own transcript is unaffected either way, since it
   * lives on this machine.
   */
  temporaryChats?: boolean;
  sessionDeviceId?: string;
  accessToken?: string;
  accessTokenExpiry?: number;
  /** Who the session belongs to, for display and per-account usage counting. */
  /**
   * The user signed out in the app. Their browser cookies are left exactly
   * where they are — signing out of OnFlip is not signing out of Chrome —
   * but they are no longer imported automatically, or the next start would
   * silently sign the user back in and logout would mean nothing.
   */
  signedOut?: boolean;
  /** The plan ChatGPT reports, e.g. "plus" or "chatgptproplan". */
  planType?: string;
  accountName?: string;
  accountEmail?: string;

  // -- model --------------------------------------------------------------
  model?: string;
  /**
   * The model above is the user's own pick, not a default that was adopted.
   *
   * Both look identical once written, and they need opposite treatment: a
   * pick is honoured forever, an adopted default is re-decided when the
   * plan changes or a build changes what the default is. Absent on configs
   * written before this existed, which start reads once and backfills.
   */
  modelPinned?: boolean;
  thinking?: string;
  /**
   * Model list read from the user's own account by `onflip models --refresh`.
   * Authoritative when present, since entitlements differ per plan and slugs
   * change faster than any list shipped in the binary.
   */
  discoveredModels?: { slug: string; title: string; description: string }[];
  modelsRefreshedAt?: number;

  // -- agent behaviour ----------------------------------------------------
  /** ApprovalMode; stored loosely so an unknown value degrades to the default. */
  approvalMode?: string;
  /** Shell tools available at all. Separate from the approval mode. */
  shell?: boolean;
  /** Network tool available at all. */
  network?: boolean;
  /**
   * Run the agent's own browser without a window.
   *
   * Off by default: watching it click through a page is most of the point,
   * and a browser that works invisibly is hard to trust or debug.
   */
  browserHeadless?: boolean;
  /**
   * Open the DevTools port the docked Browser pane is driven over.
   *
   * On by default. Turning it off removes the agent's browser tool and the
   * Browser pane along with it - the feature is that port, and there is no
   * way to keep one without the other. Worth turning off on a machine other
   * people have accounts on: the port is loopback-only and unauthenticated,
   * which stops a web page reaching it but not another local account.
   * Read before Chromium starts, so it takes effect on the next launch.
   */
  embeddedBrowser?: boolean;

  /**
   * Offer the agent the `task` tool, which hands work to a sub-agent.
   *
   * On by default. Worth turning off when you would rather watch every step
   * in one conversation: a sub-agent does its reading somewhere else and
   * brings back a paragraph, which is the point of it and also the cost -
   * and it needs a chat of its own, so the parent's thread is abandoned and
   * rebuilt on its next message, roughly what one compaction costs.
   *
   * A tool the model cannot be offered is simply absent from its roster, so
   * turning this off does not leave it calling something that will refuse.
   */
  subAgents?: boolean;

  /**
   * A message that was typed, sent, and never delivered.
   *
   * Written when a turn fails for want of a session, so the words survive
   * whatever happens next — including a provider switch, which relaunches
   * the whole app because the service is chosen at process start and a
   * session cannot move between two of them.
   *
   * Restored into the composer and never sent on its own. A prompt that
   * fires by itself after a restart is a worse outcome than a lost one:
   * losing it costs somebody thirty seconds of retyping, and sending it
   * unbidden costs them a turn they did not ask for, against whichever
   * service and folder happened to be current.
   */
  unsentPrompt?: { text: string; at: number };
  /**
   * Send "continue" by itself when a turn dies on a transport failure.
   *
   * The failure this exists for arrives after an hour of unattended work:
   * the conversation stops answering and the run stops with it, needing
   * one word from someone who is not at the desk. Bounded, because a
   * failure that is really fatal would otherwise be retried forever.
   */
  autoResume?: boolean;
  maxIterations?: number;
  /** Compact the transcript once it exceeds this many messages. */
  compactAfter?: number;
  /**
   * Compact once the transcript exceeds this many characters.
   *
   * The trigger that actually fires in practice. Tool output is what fills a
   * conversation — a build log or a file read is worth twenty exchanges — so a
   * message count reaches its limit long after the model has reached its own.
   */
  compactAfterChars?: number;
  /**
   * How long to let one reply take, in seconds.
   *
   * Reasoning effort and output size both push this up: a full-file rewrite at
   * high effort can spend minutes thinking before the first token. Esc cancels
   * a turn at any point, so a generous budget costs nothing but patience.
   */
  replyTimeout?: number;

  // -- persisted approvals ------------------------------------------------
  allowedCommands?: string[];
  allowedWriteDirs?: string[];
  /**
   * Per-command shell rules, e.g. { "*": "ask", "git *": "allow", "rm *": "deny" }.
   * Patterns support * and ?; the last matching rule wins, so a catch-all goes
   * first and refinements after it. These outrank the approval mode.
   */
  bashRules?: Record<string, string>;

  // -- interface ----------------------------------------------------------
  theme?: string;
  /**
   * Take over the terminal with the alternate screen buffer, the way a TUI
   * does. Your scrollback is untouched and comes back on exit.
   */
  fullscreen?: boolean;
  /**
   * A ChatGPT project to start new chats in, so OnFlip's conversations stay
   * out of the main sidebar. Both forms are kept: the id identifies it, the
   * short url is the only one that opens a project with a composer.
   */
  projectId?: string;
  projectShortUrl?: string;
  projectName?: string;

  /**
   * Epoch millis until which OnFlip refuses to send.
   *
   * Set when ChatGPT throttles the account. Persisted on purpose: the most
   * natural reaction to a block is to restart and try again, and that is
   * the one thing that reliably makes it last longer.
   */
  cooldownUntil?: number;

  /** Run the automation browser with a visible window. */
  headed?: boolean;
  /** Reuse a persistent browser profile between runs. */
  persistProfile?: boolean;
  /**
   * The browser the automation profile belongs to. Recorded when the user
   * signs in through it, because only that browser can read the cookies it
   * wrote: Chrome's are encrypted with a key bound to Chrome.
   */
  browserChannel?: "chrome" | "msedge" | "chromium";

  /**
   * Which chat service this install drives — "chatgpt" (the default) or
   * "deepseek". Read through `activeProvider()`, which falls back to ChatGPT
   * for anything missing or unrecognised, so a bad value cannot strand
   * someone on a provider they have not signed in to.
   */
  provider?: string;

  /**
   * Per-service settings, one room each, keyed by provider id.
   *
   * ChatGPT is not in here: its settings stay at the top level, exactly where
   * every config written before providers existed already put them, so an
   * upgrade migrates nothing. Read back through `loadConfig`, which overlays
   * the active service's room — see `PROVIDER_SCOPED` for which keys move.
   */
  providers?: Record<string, OnFlipConfig>;

  /** Legacy key from earlier versions; migrated into `shell` on load. */
  sandbox?: boolean;
}

/**
 * The services OnFlip can drive.
 *
 * Declared here rather than in `providers/` because the config has to scope
 * itself by provider, and importing the module that reads the config to find
 * out which provider is active would be a cycle. `providers/id.ts` re-exports
 * these so there is still one list.
 */
export const PROVIDER_IDS = ["chatgpt", "deepseek", "qwen"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const DEFAULT_PROVIDER: ProviderId = "chatgpt";

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Settings that belong to one service rather than to the app.
 *
 * The rest — theme, language, approvals, shell, timeouts — describe how the
 * person likes to work and are the same whichever service is answering. These
 * are different: a model slug, a plan, a session token and a discovered model
 * list are all facts about one account on one service, and letting them cross
 * is how a DeepSeek run ends up pinned to a ChatGPT model, or reports itself
 * connected because ChatGPT's cookies are in hand. Reported on the first
 * switch, both of those, within a minute of each other.
 */
const PROVIDER_SETTINGS = [
  "model",
  "thinking",
  "browserChannel",
  "signedOut",
  "planType",
  "discoveredModels",
  "accountName",
  "accountEmail",
] as const satisfies readonly (keyof OnFlipConfig)[];

/**
 * ChatGPT's session, which no other service can produce.
 *
 * A `__Secure-next-auth` cookie and the access token it buys come from one
 * place: a signed-in ChatGPT. DeepSeek keeps its session in its browser
 * profile's localStorage and writes none of these, so a copy of them inside
 * `providers.deepseek` is always something misfiled — and it was, on this
 * machine: the whole ChatGPT session, duplicated into DeepSeek's room by a
 * ChatGPT code path that ran while DeepSeek was the active service, and read
 * straight back out as "connected" on an account nobody had signed in to.
 *
 * So these are filed by whose they are rather than by who is running, and any
 * a previous version left in the wrong room are dropped on read and cleaned
 * out of the file on the next save. An account's name and plan are not in
 * this group: both services have those, and each keeps its own.
 */
const CHATGPT_SESSION = [
  "sessionToken",
  "sessionCookies",
  "sessionCookieName",
  "sessionDeviceId",
  "accessToken",
  "accessTokenExpiry",
] as const satisfies readonly (keyof OnFlipConfig)[];

/**
 * ChatGPT's alone, whichever room a previous version filed them in.
 *
 * The session is obvious. `discoveredModels` belongs here for the same
 * reason and was missed: it is the answer from ChatGPT's own model-discovery
 * endpoint, and DeepSeek's models are a fixed built-in list that is never
 * discovered at all. So a copy of it inside another service's room is always
 * misfiled - found in the field holding nineteen gpt-* slugs under
 * `providers.deepseek`, written there by the cross-provider bleed that
 * `ONFLIP_PROVIDER` pinning later closed.
 */
const CHATGPT_ONLY = [...CHATGPT_SESSION, "discoveredModels"] as const satisfies
  readonly (keyof OnFlipConfig)[];

/** Everything another service must not read out of ChatGPT's top level. */
const PROVIDER_SCOPED = [...PROVIDER_SETTINGS, ...CHATGPT_SESSION] as const;

/**
 * ChatGPT keeps the top level, everything else gets a room of its own.
 *
 * No migration, and no risk to a working install: a config written before
 * providers existed is already exactly what ChatGPT should read.
 */
function scopeOf(raw: { provider?: unknown }): ProviderId {
  const forced = process.env.ONFLIP_PROVIDER?.trim().toLowerCase();
  if (isProviderId(forced)) return forced;
  return isProviderId(raw?.provider) ? raw.provider : DEFAULT_PROVIDER;
}

const CONFIG_DIR = path.join(os.homedir(), ".onflip");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function configDir(): string {
  return CONFIG_DIR;
}

/**
 * Create a directory only this user can enter, and repair one that is not.
 *
 * `mkdirSync` takes the process umask, which on a typical Unix account means
 * 0755 — readable and listable by every other account on the machine. For
 * somewhere holding browser profiles, session files, logs, screenshots and
 * transcripts, that is the wrong default: an external audit found the whole
 * `~/.onflip` tree world-readable, with only the individual config files
 * restricted.
 *
 * The mode is set explicitly rather than left to `mkdirSync`'s `mode`
 * argument alone, because that argument is also masked by the umask and
 * because a directory created by an earlier version is already there with
 * the old mode. Both cases end at 0700.
 *
 * Failure is deliberately quiet. On Windows `chmod` is close to a no-op —
 * the ACL is what matters there, and the per-user profile directory is
 * already restricted — and a read-only home should not stop the agent
 * running. The directory being created is the part that must work; its mode
 * is a hardening step, not a precondition.
 */
export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not every filesystem or platform honours it */
  }
}

export function configPath(): string {
  return CONFIG_PATH;
}

/**
 * Set while the config file exists but could not be read back.
 *
 * A parse failure used to read as an empty config, and the next save merged
 * its patch into that emptiness and wrote the result over the file — one bad
 * byte in config.json, from a write cut short or a hand edit, and the session
 * cookies, the token, the model and every rule were gone. Now the file is set
 * aside for inspection and every write is refused until a load succeeds.
 */
let lastLoadFailed = false;
/** The copy is made once per process, not once per load. */
let quarantined = false;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * PowerShell's `Set-Content -Encoding utf8` puts a byte-order mark on the
 * file and JSON.parse rejects it, so a hand-edited config.json — or session
 * file — would otherwise count as corrupt. Spelled as a code point rather
 * than a literal, which is invisible in source.
 */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function quarantineConfig(error: unknown): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = `${CONFIG_PATH}.corrupt-${stamp}`;
  let copied = false;
  if (!quarantined) {
    quarantined = true;
    try {
      fs.copyFileSync(CONFIG_PATH, copy);
      copied = true;
    } catch {
      // Best effort: the original is left where it is either way.
    }
  }
  logger.warn("config", "config.json could not be parsed; leaving it as it is and refusing to save over it", {
    path: CONFIG_PATH,
    error: error instanceof Error ? error.message : String(error),
    copy: copied ? copy : null,
  });
}

export function loadConfig(): OnFlipConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (e) {
    // No file is the fresh-install case. Anything else — permissions, a
    // directory in its place — means the contents are unknown, and writing
    // over unknown contents is how they get lost.
    lastLoadFailed = !isMissing(e);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom(raw));
  } catch (e) {
    if (!lastLoadFailed) quarantineConfig(e);
    lastLoadFailed = true;
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!lastLoadFailed) quarantineConfig(new Error("the file is valid JSON but not an object"));
    lastLoadFailed = true;
    return {};
  }
  lastLoadFailed = false;
  quarantined = false;
  const stored = parsed as OnFlipConfig & { providers?: Record<string, OnFlipConfig> };
  const config: OnFlipConfig = { ...stored };
  delete (config as { providers?: unknown }).providers;

  const scope = scopeOf(stored);
  if (scope !== DEFAULT_PROVIDER) {
    // The scoped keys come from this provider's room, and *only* from it —
    // falling back to the top level would hand DeepSeek ChatGPT's model and
    // its session, which is the bleed this exists to stop.
    const own = stored.providers?.[scope] ?? {};
    for (const key of PROVIDER_SCOPED) delete config[key];
    Object.assign(config, own);
    // And not from its own room either. A copy of ChatGPT's session found
    // there was misfiled by an earlier version, and reading it back is the
    // reported symptom itself: DeepSeek announcing a connected account on a
    // service that had never been signed in to.
    for (const key of CHATGPT_ONLY) delete config[key];

    // An account name identical to ChatGPT's is ChatGPT's.
    //
    // `resolveAuth` used to record the account from ChatGPT's own session
    // endpoint whoever was running, and file it — correctly, by the rules
    // above — in the active service's room. That write is fixed at the
    // source, but every install that ever ran a browser-driven service still
    // carries the result: a real ChatGPT name and email sitting in
    // `providers.deepseek` and `providers.qwen`.
    //
    // It cannot be left to correct itself. DeepSeek would, on its next turn,
    // because its page names the account. Qwen's does not name it at all —
    // measured: no name element, no email anywhere in the page — so
    // `pageSessionUser` answers null, the identify step returns early, and
    // the wrong name would stay on a Qwen account bar for good.
    //
    // So it is dropped on read, the way a misfiled session is, rather than
    // migrated with a file write: nothing has to run once, nothing can half
    // apply, and a service that really does report a name writes one that
    // differs from ChatGPT's and is read back normally. The cost of being
    // wrong — two accounts genuinely sharing a name — is an account bar that
    // says "DeepSeek account" until the next turn names it properly.
    if (own.accountName && own.accountName === stored.accountName) delete config.accountName;
    if (own.accountEmail && own.accountEmail === stored.accountEmail) delete config.accountEmail;
  }

  // `sandbox` used to mean "shell allowed". Keep old configs working.
  if (config.shell === undefined && typeof config.sandbox === "boolean") {
    config.shell = config.sandbox;
  }
  return config;
}

/**
 * Write a file so that a crash mid-write cannot leave it truncated.
 *
 * The contents go to a sibling temp file and are renamed into place; the
 * rename is atomic on every filesystem this runs on, so a reader sees either
 * the old file or the new one and never half of the new one. Shared with the
 * session store, which has the same thing to lose.
 */
export function writeFileAtomically(file: string, contents: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The temp file is the lesser problem; the rename failure is reported.
    }
    throw e;
  }
}

function writeConfig(config: OnFlipConfig, action: string): void {
  if (lastLoadFailed) {
    logger.warn("config", `not ${action}: the existing config.json could not be read, and saving would overwrite it`, {
      path: CONFIG_PATH,
    });
    return;
  }
  try {
    mkdirPrivate(CONFIG_DIR);
    writeFileAtomically(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // A read-only home directory should not stop the agent from running.
  }
}

export function saveConfig(patch: OnFlipConfig): void {
  // Load first: it is what decides whether the file may be written at all.
  // `readRaw` cannot answer that — it swallows a parse failure and returns an
  // empty object, and merging a patch into that empties the file.
  loadConfig();
  const stored = readRaw();
  const scope = scopeOf(stored);
  if (scope === DEFAULT_PROVIDER) {
    writeConfig({ ...stored, ...patch }, "saving config");
    return;
  }
  // Split the patch three ways: this service's own settings go in its room,
  // ChatGPT's session goes to ChatGPT's room whoever is running, and the rest
  // stays at the top level where both services read it.
  const scoped: OnFlipConfig = {};
  const shared: OnFlipConfig = {};
  for (const [key, value] of Object.entries(patch)) {
    const target = (PROVIDER_SETTINGS as readonly string[]).includes(key) ? scoped : shared;
    (target as Record<string, unknown>)[key] = value;
  }
  const providers = { ...(stored.providers ?? {}) };
  const room: OnFlipConfig = { ...(providers[scope] ?? {}), ...scoped };
  for (const key of CHATGPT_ONLY) delete room[key];
  providers[scope] = room;
  writeConfig({ ...stored, ...shared, providers }, "saving config");
}

/** The file as written, without any provider overlay applied. */
function readRaw(): OnFlipConfig & { providers?: Record<string, OnFlipConfig> } {
  try {
    const parsed = JSON.parse(withoutBom(fs.readFileSync(CONFIG_PATH, "utf8")));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* handled by loadConfig, which decides whether writing is safe at all */
  }
  return {};
}

/**
 * Remove keys entirely rather than setting them to undefined.
 *
 * From the active service's room, and only from it. Written against the file
 * rather than against `loadConfig()`, which returns the two rooms already
 * merged into one and with `providers` stripped off: writing that back put
 * DeepSeek's model and session where ChatGPT reads them and deleted every
 * other room in the file. Signing out of one service would have taken the
 * other's saved session with it.
 */
export function clearConfigKeys(keys: (keyof OnFlipConfig)[]): void {
  loadConfig(); // for the refusal check on an unreadable file
  const stored = readRaw();
  const scope = scopeOf(stored);
  if (scope === DEFAULT_PROVIDER) {
    for (const key of keys) delete stored[key];
  } else {
    const room = { ...(stored.providers?.[scope] ?? {}) };
    for (const key of keys) delete room[key];
    stored.providers = { ...(stored.providers ?? {}), [scope]: room };
  }
  writeConfig(stored, "clearing config keys");
}

/**
 * First candidate that is a usable positive integer.
 *
 * Exists because `Number(undefined) ?? fallback` does not do what it looks
 * like: `Number` yields NaN rather than undefined, `??` passes NaN straight
 * through, and the NaN then silently poisons every comparison downstream.
 */
export function firstPositiveInt(
  candidates: (number | string | undefined | null)[],
  fallback: number
): number {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return fallback;
}

/**
 * Read a boolean from the environment, tolerating the spellings people
 * actually type. Returns undefined when the variable is unset.
 */
export function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes", "enable", "enabled"].includes(v)) return true;
  if (["0", "false", "off", "no", "disable", "disabled"].includes(v)) return false;
  return undefined;
}

/**
 * A message worth offering back, or nothing.
 *
 * Bounded in time because the point is to rescue a message somebody was in
 * the middle of, not to hand back something they typed last Tuesday and have
 * long since forgotten — which would arrive as a mystery in the composer.
 *
 * Pure, so the window it covers can be held against real clocks.
 */
export function unsentPromptToRestore(
  saved: { text: string; at: number } | undefined,
  now: number = Date.now(),
  withinMs: number = 30 * 60_000
): string | null {
  const text = saved?.text?.trim();
  if (!text) return null;
  const at = saved?.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  // A clock that went backwards is not a reason to throw the message away.
  if (now - at > withinMs) return null;
  return text;
}
