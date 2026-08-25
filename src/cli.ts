import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import { Repl, VERSION } from "./repl";
import { configPath, loadConfig, saveConfig, clearConfigKeys, envFlag } from "./config";
import {
  allModels,
  modelSlugs,
  modelsRefreshedAt,
  cacheModels,
  clearModelCache,
  THINKING_LEVELS,
  isThinkingLevel,
  normalizeModel,
} from "./models";
import { ApprovalMode, APPROVAL_MODES, APPROVAL_DESCRIPTIONS, isApprovalMode } from "./agent/permissions";
import { spawnExtractToken } from "./auth/extract";
import {
  openLoginWindow,
  closeBrowser,
  configureBrowser,
  listConversations,
  listProjects,
} from "./chatgpt/browser-client";
import { discoverModels } from "./chatgpt/models-api";
import { resolveAuth } from "./auth/resolve";
import { listSessions, deleteSession, loadSession, relativeTime } from "./agent/store";
import { setTheme, theme, THEME_NAMES } from "./ui/theme";
import { confirm } from "./ui/prompt";
import { releaseRaw } from "./ui/keys";
import * as ui from "./ui/render";
import { openLog } from "./log";
import { cooldownRemainingMs, describeWait } from "./chatgpt/backoff";

interface ParsedArgs {
  command: string | null;
  positional: string[];
  model?: string;
  thinking?: string;
  approvalMode?: ApprovalMode;
  shell?: boolean;
  network?: boolean;
  maxIterations?: number;
  token?: string;
  theme?: string;
  cwd?: string;
  print?: boolean;
  headed?: boolean;
  resumeId?: string;
  continueLatest?: boolean;
  help?: boolean;
  version?: boolean;
  refresh?: boolean;
  debug?: boolean;
  fullscreen?: boolean;
}

const SUBCOMMANDS = new Set([
  "run",
  "login",
  "logout",
  "status",
  "models",
  "sessions",
  "chats",
  "projects",
  "config",
  "init",
  "help",
  "logs",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = { command: null, positional: [] };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];

    switch (a) {
      case "-h":
      case "--help":
        parsed.help = true;
        continue;
      case "-v":
      case "--version":
        parsed.version = true;
        continue;
      case "-m":
      case "--model":
        parsed.model = normalizeModel(next());
        continue;
      case "--thinking":
      case "--think":
      case "--effort":
      case "--reasoning-effort": {
        const level = (next() ?? "").toLowerCase();
        if (!isThinkingLevel(level)) {
          fail(`Invalid thinking level "${level}". Use one of: ${THINKING_LEVELS.join(", ")}`);
        }
        parsed.thinking = level;
        continue;
      }
      case "-a":
      case "--approve":
      case "--approval-mode": {
        const mode = (next() ?? "").toLowerCase();
        if (!isApprovalMode(mode)) {
          fail(`Invalid approval mode "${mode}". Use one of: ${APPROVAL_MODES.join(", ")}`);
        }
        parsed.approvalMode = mode;
        continue;
      }
      case "--yolo":
        parsed.approvalMode = "yolo";
        continue;
      case "--auto":
      case "--full-auto":
        parsed.approvalMode = "full-auto";
        continue;
      case "--plan":
      case "--read-only":
        parsed.approvalMode = "read-only";
        continue;
      case "--shell":
        parsed.shell = true;
        continue;
      case "--no-shell":
        parsed.shell = false;
        continue;
      case "--network":
        parsed.network = true;
        continue;
      case "--no-network":
        parsed.network = false;
        continue;
      case "--max-iterations":
      case "--max-steps":
        parsed.maxIterations = Math.max(1, Number(next()) || 40);
        continue;
      case "--token":
        parsed.token = next();
        continue;
      case "--theme":
        parsed.theme = next();
        continue;
      case "-C":
      case "--cwd":
        parsed.cwd = next();
        continue;
      case "-p":
      case "--print":
        parsed.print = true;
        continue;
      case "--headed":
        parsed.headed = true;
        continue;
      case "--headless":
        parsed.headed = false;
        continue;
      case "--refresh":
        parsed.refresh = true;
        continue;
      case "--debug":
      case "-d":
        parsed.debug = true;
        continue;
      case "--fullscreen":
        parsed.fullscreen = true;
        continue;
      case "--inline":
      case "--no-fullscreen":
        parsed.fullscreen = false;
        continue;
      case "-c":
      case "--continue":
        parsed.continueLatest = true;
        continue;
      case "-r":
      case "--resume":
        // `--resume` with no id opens the picker.
        if (args[i + 1] && !args[i + 1].startsWith("-")) parsed.resumeId = next();
        else parsed.continueLatest = true;
        continue;
      // Legacy spellings from 0.1.x.
      case "--sandbox":
        parsed.shell = true;
        continue;
      case "--no-sandbox":
        parsed.shell = false;
        continue;
      case "--no-tools":
        parsed.approvalMode = "read-only";
        continue;
    }

    if (a.startsWith("-") && a !== "-") {
      // Subcommands carry their own flags (`logs -n 20 --raw`). Once a
      // subcommand is chosen, anything unrecognised belongs to it rather than
      // being a mistake — it gets validated by the subcommand itself.
      if (parsed.command) {
        parsed.positional.push(a);
        continue;
      }
      fail(`Unknown option "${a}". Run \`onflip --help\` for usage.`);
    }

    if (parsed.command === null && SUBCOMMANDS.has(a)) parsed.command = a;
    else parsed.positional.push(a);
  }

  return parsed;
}

function fail(message: string): never {
  ui.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function printHelp(): void {
  const t = theme();
  process.stdout.write("\n");
  process.stdout.write(`  ${chalk.hex(t.accent).bold("onflip")} ${chalk.hex(t.muted)(`v${VERSION}`)}\n`);
  process.stdout.write(
    `  ${chalk.hex(t.muted)("An autonomous coding agent driven by your ChatGPT web session.")}\n`
  );

  ui.commandHelp("Usage", [
    { name: "onflip", description: "open the interactive session" },
    { name: "onflip", args: "<dir>", description: "open a project folder" },
    { name: "onflip", args: '"<task>"', description: "run one task and exit" },
    { name: "onflip -p", args: '"<task>"', description: "run one task, print the answer only" },
    { name: "onflip -c", description: "continue the last session in this directory" },
    { name: "onflip -r", args: "[id]", description: "resume a session (picker when no id)" },
  ]);

  ui.commandHelp("Commands", [
    { name: "login", args: "[--headed]", description: "capture your ChatGPT session from a browser" },
    { name: "logout", description: "forget the stored session" },
    { name: "status", description: "show configuration and session state" },
    { name: "sessions", args: "[rm <id>]", description: "list or delete saved sessions" },
    { name: "chats", args: "[filter]", description: "list your ChatGPT conversations" },
    { name: "projects", description: "list your ChatGPT projects" },
    { name: "models", args: "[--refresh]", description: "list models, or re-read them from your account" },
    { name: "config", args: "[key] [value]", description: "read or write a config value" },
    { name: "init", description: "write an AGENTS.md for this project" },
    { name: "logs", args: "[-n <count>] [--raw]", description: "show the most recent session log" },
  ]);

  ui.commandHelp("Options", [
    { name: "-m, --model", args: "<slug>", description: `model to use (${modelSlugs().slice(0, 4).join(", ")}, …)` },
    { name: "--thinking", args: "<level>", description: `reasoning effort (${THINKING_LEVELS.join(", ")})` },
    { name: "-a, --approve", args: "<mode>", description: `approval mode (${APPROVAL_MODES.join(", ")})` },
    { name: "--yolo", description: "full shell access; only deny rules still block" },
    { name: "--full-auto", description: "approve everything except destructive commands" },
    { name: "--plan", description: "read-only: no writes, no commands" },
    { name: "--no-shell", description: "hide the shell tools entirely" },
    { name: "--no-network", description: "hide the network tool entirely" },
    { name: "--max-steps", args: "<n>", description: "step budget per turn (default 40)" },
    { name: "-C, --cwd", args: "<dir>", description: "working directory" },
    { name: "--theme", args: "<name>", description: `colour theme (${THEME_NAMES.join(", ")})` },
    { name: "--headed", description: "show the automation browser window" },
    { name: "--inline", description: "render into scrollback instead of taking over the screen" },
    { name: "-d, --debug", description: "verbose logging, echoed to stderr" },
    { name: "--token", args: "<value>", description: "supply the session token directly" },
  ]);

  ui.commandHelp("Approval modes", APPROVAL_MODES.map((m) => ({ name: m, description: APPROVAL_DESCRIPTIONS[m] })));

  ui.commandHelp("Environment", [
    { name: "ONFLIP_SESSION_TOKEN", description: "session token, instead of browser extraction" },
    { name: "ONFLIP_MODEL", description: "default model" },
    { name: "ONFLIP_THINKING", description: "default reasoning effort" },
    { name: "ONFLIP_TRANSPORT", description: "force 'browser' or 'api'" },
    { name: "ONFLIP_MAX_ITERATIONS", description: "default step budget" },
  ]);
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function doLogin(headed: boolean): Promise<void> {
  if (headed) {
    ui.info("Opening a browser window. Sign in to ChatGPT, then come back here.");
    configureBrowser({ headed: true, persistProfile: true });
    saveConfig({ persistProfile: true });
    await openLoginWindow([]);
    const done = await confirm("Signed in and the chat page has loaded?", true);
    if (done) {
      ui.success("Profile saved. OnFlip will reuse this browser profile from now on.");
    } else {
      ui.notice("Left as-is. Run `onflip login --headed` again when you are signed in.");
    }
    await closeBrowser();
    return;
  }

  ui.startSpinner("looking for a ChatGPT session in your browsers");
  let token: string | undefined;
  let cookieName: string | undefined;
  let deviceId: string | undefined;
  let source: string | undefined;
  try {
    const extracted = spawnExtractToken();
    token = extracted?.primary.value;
    cookieName = extracted?.primary.name;
    deviceId = extracted?.deviceId;
    source = extracted?.source;
  } catch (e) {
    ui.stopSpinner();
    ui.error(e instanceof Error ? e.message : String(e));
    ui.info("If your browser uses app-bound cookie encryption, try: onflip login --headed");
    process.exit(1);
  }
  ui.stopSpinner();

  if (!token) {
    ui.error("No ChatGPT session found in any installed browser.");
    ui.info("Log in at https://chatgpt.com first, then run `onflip login` again.");
    ui.info("Alternatively run `onflip login --headed` to sign in through OnFlip's own browser.");
    process.exit(1);
  }

  saveConfig({ sessionToken: token, sessionCookieName: cookieName, sessionDeviceId: deviceId });
  ui.success(`Session captured from ${source ?? "your browser"} and saved to ${configPath()}`);
}

function doLogout(): void {
  clearConfigKeys(["sessionToken", "sessionCookieName", "sessionDeviceId", "accessToken", "accessTokenExpiry"]);
  ui.success("Stored session cleared.");
  ui.info("The browser profile is untouched — delete ~/.onflip/browser-profile to remove that too.");
}

function doStatus(): void {
  // Shown first: a cooldown is the reason nothing is sending, and burying it
  // under the configuration is how someone restarts straight into the block.
  const cooling = cooldownRemainingMs();
  if (cooling > 0) {
    ui.notice(
      `ChatGPT is throttling this account — OnFlip is waiting ${describeWait(cooling)} before sending again.`
    );
    ui.blank();
  }
  const config = loadConfig();
  const sessions = listSessions({ limit: 1 });
  ui.panel("OnFlip", [
    { label: "version", value: VERSION },
    { label: "model", value: config.model ?? "auto" },
    { label: "thinking", value: config.thinking ?? "default" },
    { label: "approval", value: config.approvalMode ?? "ask" },
    { label: "shell", value: config.shell === false ? "disabled" : "enabled" },
    { label: "network", value: config.network === false ? "disabled" : "enabled" },
    { label: "theme", value: config.theme ?? "opencode" },
    {
      label: "session",
      value: config.sessionToken
        ? chalk.hex("#7fd88f")("stored")
        : chalk.hex("#e06c75")("missing — run `onflip login`"),
    },
    { label: "profile", value: config.persistProfile === false ? "disposable" : "persistent" },
    { label: "terminal", value: describeTerminal() },
    { label: "approved", value: `${(config.allowedCommands ?? []).length} commands, ${(config.allowedWriteDirs ?? []).length} directories` },
    { label: "last chat", value: sessions[0] ? `${sessions[0].title} (${relativeTime(sessions[0].updatedAt)})` : "none" },
    { label: "config", value: configPath() },
  ]);
}

/**
 * Whether this terminal can drive the composer.
 *
 * A launcher that pipes stdin — some npm shims do — leaves stdout a console
 * while stdin is a pipe, and the composer silently degrades to reading whole
 * lines. Surfacing it here makes that diagnosable instead of mystifying.
 */
function describeTerminal(): string {
  const inTTY = Boolean(process.stdin.isTTY);
  const outTTY = Boolean(process.stdout.isTTY);
  const raw = inTTY && typeof process.stdin.setRawMode === "function";
  if (raw && outTTY) {
    return chalk.hex("#7fd88f")(`interactive (${process.stdout.columns ?? "?"} cols)`);
  }
  const why = !inTTY ? "stdin is not a console" : !outTTY ? "stdout is not a console" : "raw mode unavailable";
  return chalk.hex("#e6b673")(`line mode — ${why}`);
}

async function doModels(positional: string[], refresh: boolean): Promise<void> {
  if (positional.includes("clear")) {
    clearModelCache();
    ui.success("Cached model list cleared — the built-in defaults apply again.");
    return;
  }

  if (refresh) {
    ui.startSpinner("reading the model list from your account");
    try {
      const auth = await resolveAuth();
      const { models, source } = await discoverModels(auth);
      cacheModels(models.map((m) => ({ slug: m.slug, title: m.title, description: m.description })));
      ui.stopSpinner();
      ui.success(`Found ${models.length} models on your account (via ${source}).`);
    } catch (e) {
      ui.stopSpinner();
      ui.error(e instanceof Error ? e.message : String(e));
      ui.info("The built-in list still applies, and any slug can be used with --model regardless.");
      process.exitCode = 1;
      return;
    } finally {
      await closeBrowser().catch(() => {});
    }
  }

  const models = allModels();
  ui.commandHelp(
    "Models",
    models.map((m) => ({
      name: m.slug,
      description: m.description || m.label,
    }))
  );

  const refreshedAt = modelsRefreshedAt();
  if (refreshedAt) {
    ui.info(`From your account, refreshed ${relativeTime(refreshedAt)}. Update with: onflip models --refresh`);
  } else {
    ui.info("Built-in defaults. Read the real list for your account with: onflip models --refresh");
  }
  ui.info("Any other slug the backend accepts also works, listed or not.");
  ui.blank();
}

/**
 * List the account's own ChatGPT conversations.
 *
 * Read-only here on purpose: continuing one needs a live session to attach it
 * to, so `/chats` inside a session is where the picking happens. This exists so
 * you can see what is there — and copy a title to filter on — without starting
 * anything.
 */
async function doChats(positional: string[]): Promise<void> {
  const auth = await resolveAuth();
  if (auth.cookies.length === 0) {
    fail("Continuing a ChatGPT conversation needs a browser session. Run `onflip login` first.");
  }

  ui.startSpinner("reading your ChatGPT conversations");
  let chats;
  try {
    chats = await listConversations(auth.cookies);
  } catch (e) {
    ui.stopSpinner();
    await closeBrowser();
    fail(`Could not read your conversations: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ui.stopSpinner();
  }
  await closeBrowser();

  const query = positional.join(" ").trim().toLowerCase();
  const matching = query ? chats.filter((c) => c.title.toLowerCase().includes(query)) : chats;

  if (matching.length === 0) {
    ui.info(query ? `No conversation matching "${query}".` : "No ChatGPT conversations found.");
    return;
  }

  ui.commandHelp(
    query ? `ChatGPT conversations matching "${query}"` : "Your ChatGPT conversations",
    matching.slice(0, 25).map((c) => ({
      name: c.title.slice(0, 46),
      description: c.updatedAt ? relativeTime(c.updatedAt) : c.id.slice(0, 8),
    }))
  );
  ui.info("Continue one from inside a session with /chats.");
  ui.blank();
}

/** List the account's ChatGPT projects, for picking one with `/project`. */
async function doProjects(): Promise<void> {
  const auth = await resolveAuth();
  if (auth.cookies.length === 0) {
    fail("Projects need a browser session. Run `onflip login` first.");
  }

  ui.startSpinner("reading your ChatGPT projects");
  let projects;
  try {
    projects = await listProjects(auth.cookies);
  } catch (e) {
    ui.stopSpinner();
    await closeBrowser();
    fail(`Could not read your projects: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ui.stopSpinner();
  }
  await closeBrowser();

  const current = loadConfig().projectId;
  if (projects.length === 0) {
    ui.info("No projects yet. Create one with /project new <name> inside a session.");
    return;
  }

  ui.commandHelp(
    "Your ChatGPT projects",
    projects.map((p) => ({
      name: p.name.slice(0, 40),
      description: p.id === current ? "new chats go here" : p.id.slice(0, 16),
    }))
  );
  ui.info("Choose one inside a session with /project.");
  ui.blank();
}

async function doSessions(positional: string[]): Promise<void> {
  const [action, id] = positional;

  if (action === "rm" || action === "delete") {
    if (!id) fail("Give a session id: onflip sessions rm <id>");
    if (!loadSession(id)) fail(`No session with id ${id}.`);
    if (deleteSession(id)) ui.success(`Deleted session ${id}.`);
    else ui.error(`Could not delete session ${id}.`);
    return;
  }

  if (action === "clear") {
    const all = listSessions();
    if (all.length === 0) {
      ui.info("No sessions to delete.");
      return;
    }
    const sure = await confirm(`Delete all ${all.length} saved sessions?`);
    if (!sure) {
      ui.info("Left unchanged.");
      return;
    }
    let removed = 0;
    for (const s of all) if (deleteSession(s.id)) removed++;
    ui.success(`Deleted ${removed} sessions.`);
    return;
  }

  const sessions = listSessions({ limit: 25 });
  if (sessions.length === 0) {
    ui.info("No saved sessions yet.");
    return;
  }
  ui.commandHelp(
    "Sessions",
    sessions.map((s) => ({
      name: s.id,
      description: `${s.title}  ·  ${relativeTime(s.updatedAt)}  ·  ${s.messageCount} msgs  ·  ${path.basename(s.cwd)}`,
    }))
  );
  ui.info("Resume one with: onflip --resume <id>");
  ui.blank();
}

/**
 * Show the most recent session log.
 *
 * Rendered as a readable timeline by default; `--raw` prints the JSONL for
 * grepping, and `--full` stops eliding the long payload fields that are the
 * whole reason the log exists.
 */
function doLogs(positional: string[]): void {
  const t = theme();
  const dir = path.join(path.dirname(configPath()), "logs");

  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    files = [];
  }
  if (files.length === 0) {
    ui.info("No logs yet. Run a session, or `onflip --debug` for a verbose one.");
    return;
  }

  const raw = positional.includes("--raw") || positional.includes("raw");
  const full = positional.includes("--full") || positional.includes("full");
  const nIndex = positional.findIndex((a) => a === "-n" || a === "--lines");
  const limit = nIndex !== -1 ? Math.max(1, Number(positional[nIndex + 1]) || 60) : 60;

  const named = positional.find((a) => a.endsWith(".jsonl") || /^\d{14}/.test(a));
  const file = named
    ? files.find((f) => path.basename(f).startsWith(named)) ?? files[0]
    : files[0];

  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const shown = lines.slice(-limit);

  if (raw) {
    process.stdout.write(`${shown.join("\n")}\n`);
    return;
  }

  ui.blank();
  ui.info(`${file}  (${lines.length} events, showing last ${shown.length})`);
  ui.blank();

  const colour: Record<string, string> = {
    debug: t.border,
    info: t.muted,
    warn: t.warning,
    error: t.error,
  };

  for (const line of shown) {
    let e: { at?: string; level?: string; scope?: string; msg?: string; data?: Record<string, unknown> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const time = (e.at ?? "").slice(11, 19);
    const level = e.level ?? "info";
    process.stdout.write(
      `  ${chalk.hex(t.border)(time)} ${chalk.hex(colour[level] ?? t.muted)(level.padEnd(5))} ` +
        `${chalk.hex(t.secondary)((e.scope ?? "").padEnd(9))}${chalk.hex(t.text)(e.msg ?? "")}\n`
    );
    for (const [k, v] of Object.entries(e.data ?? {})) {
      if (v === null || v === undefined) continue;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      if (full || text.length <= 100) {
        // Multi-line payloads are indented so their structure stays visible —
        // that structure is usually the bug.
        const [first, ...rest] = text.split("\n");
        process.stdout.write(`  ${" ".repeat(9)}${chalk.hex(t.border)(`${k}:`)} ${chalk.hex(t.muted)(first)}\n`);
        for (const r of rest) process.stdout.write(`  ${" ".repeat(11 + k.length)}${chalk.hex(t.muted)(r)}\n`);
      } else {
        process.stdout.write(
          `  ${" ".repeat(9)}${chalk.hex(t.border)(`${k}:`)} ${chalk.hex(t.muted)(`${text.slice(0, 100)}… (${text.length} chars, --full to see it)`)}\n`
        );
      }
    }
  }
  ui.blank();
}

function doConfig(positional: string[]): void {
  const [key, ...valueParts] = positional;
  const config = loadConfig();

  if (!key) {
    const redacted = { ...config };
    if (redacted.sessionToken) redacted.sessionToken = `${redacted.sessionToken.slice(0, 12)}…`;
    if (redacted.accessToken) redacted.accessToken = `${redacted.accessToken.slice(0, 12)}…`;
    ui.panel(
      "Config",
      Object.entries(redacted).map(([k, v]) => ({
        label: k,
        value: Array.isArray(v) ? `[${v.length}]` : String(v),
      }))
    );
    ui.info(`File: ${configPath()}`);
    ui.blank();
    return;
  }

  const raw = valueParts.join(" ");
  if (!raw) {
    const value = (config as Record<string, unknown>)[key];
    ui.info(`${key} = ${value === undefined ? "(unset)" : JSON.stringify(value)}`);
    ui.blank();
    return;
  }

  // Coerce the value into the shape the key expects.
  let parsed: unknown = raw;
  if (raw === "true") parsed = true;
  else if (raw === "false") parsed = false;
  else if (/^-?\d+$/.test(raw)) parsed = Number(raw);

  if (key === "approvalMode" && !isApprovalMode(String(parsed))) {
    fail(`Invalid approval mode. Use one of: ${APPROVAL_MODES.join(", ")}`);
  }
  if (key === "theme" && !THEME_NAMES.includes(String(parsed))) {
    fail(`Invalid theme. Use one of: ${THEME_NAMES.join(", ")}`);
  }
  if (key === "thinking" && !isThinkingLevel(String(parsed))) {
    fail(`Invalid thinking level. Use one of: ${THINKING_LEVELS.join(", ")}`);
  }

  saveConfig({ [key]: parsed } as never);
  ui.success(`${key} = ${JSON.stringify(parsed)}`);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // Theme has to be applied before anything renders.
  const config = loadConfig();
  setTheme(args.theme ?? config.theme ?? "opencode");
  if (args.theme && !THEME_NAMES.includes(args.theme)) {
    fail(`Unknown theme "${args.theme}". Available: ${THEME_NAMES.join(", ")}`);
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.help || args.command === "help") {
    printHelp();
    return;
  }

  if (args.debug) {
    process.env.ONFLIP_DEBUG = "1";
    // Echo to stderr so a piped run still shows the trace, and open the log
    // now so anything before the session id exists is still captured.
    openLog(`debug-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`, {
      level: "debug",
      echo: true,
    });
  }
  if (args.token) process.env.ONFLIP_SESSION_TOKEN = args.token;
  if (args.headed !== undefined) saveConfig({ headed: args.headed, persistProfile: true });

  switch (args.command) {
    case "login":
      return doLogin(args.headed ?? false);
    case "logout":
      return doLogout();
    case "status":
      return doStatus();
    case "models":
      return doModels(args.positional, args.refresh ?? false);
    case "sessions":
      return doSessions(args.positional);
    case "chats":
      return doChats(args.positional);
    case "projects":
      return doProjects();
    case "config":
      return doConfig(args.positional);
    case "logs":
      return doLogs(args.positional);
  }

  // `onflip ~/code/thing` opens that project, the way `code .` does. Only a
  // single positional that resolves to a real directory qualifies, so a task
  // is never mistaken for one — but `onflip .` has to work, because it is the
  // first thing anyone tries.
  let cwdArg = args.cwd;
  let positional = args.positional;
  if (!cwdArg && positional.length === 1 && !args.print) {
    const candidate = path.resolve(expandHome(positional[0]));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      cwdArg = candidate;
      positional = [];
    }
  }

  const cwd = path.resolve(expandHome(cwdArg ?? process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    fail(`Not a directory: ${cwd}`);
  }
  process.chdir(cwd);

  const task = positional.join(" ").trim();

  // `onflip init` runs the same flow as `/init` inside a session.
  const initTask =
    args.command === "init"
      ? "Explore this codebase and write an AGENTS.md that accurately describes the project: what it is, the build/test/lint commands that actually work, the architecture worth knowing, and the conventions to follow. Verify each command exists before documenting it. Keep it concise."
      : undefined;

  const repl = new Repl({
    cwd,
    model: args.model,
    thinking: args.thinking,
    approvalMode: args.approvalMode ?? approvalFromEnv(),
    shell: args.shell ?? envFlag("ONFLIP_SANDBOX") ?? envFlag("ONFLIP_SHELL"),
    network: args.network,
    maxIterations: args.maxIterations,
    task: initTask ?? (task || undefined),
    print: args.print,
    resumeId: args.resumeId,
    continueLatest: args.continueLatest,
    // Print mode never takes the screen: its whole point is a pipeable stdout,
    // and a one-shot task has no composer to anchor a frame around.
    fullscreen: args.print ? false : args.fullscreen,
  });

  await repl.start();
}

/** Expand a leading `~`, which a shell would have done had it not been quoted. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function approvalFromEnv(): ApprovalMode | undefined {
  const raw = (process.env.ONFLIP_APPROVAL ?? "").toLowerCase();
  return isApprovalMode(raw) ? raw : undefined;
}

export { releaseRaw };
