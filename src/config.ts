import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

  /** Legacy key from earlier versions; migrated into `shell` on load. */
  sandbox?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".onflip");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function configDir(): string {
  return CONFIG_DIR;
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): OnFlipConfig {
  let config: OnFlipConfig;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as OnFlipConfig;
  } catch {
    return {};
  }
  // `sandbox` used to mean "shell allowed". Keep old configs working.
  if (config.shell === undefined && typeof config.sandbox === "boolean") {
    config.shell = config.sandbox;
  }
  return config;
}

export function saveConfig(patch: OnFlipConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const merged: OnFlipConfig = { ...loadConfig(), ...patch };
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A read-only home directory should not stop the agent from running.
  }
}

/** Remove keys entirely rather than setting them to undefined. */
export function clearConfigKeys(keys: (keyof OnFlipConfig)[]): void {
  try {
    const config = loadConfig();
    for (const key of keys) delete config[key];
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* nothing to clear */
  }
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
