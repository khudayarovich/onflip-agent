/**
 * Engine entry point — a plain Node child of the Electron main process.
 *
 * It runs as ordinary Node rather than inside Electron so the core behaves
 * exactly as it does under the CLI: Playwright launches the same browser, and
 * better-sqlite3's prebuilt binding matches the Node ABI (Electron's does
 * not, and cookie extraction would break there).
 *
 * stdout carries the RPC protocol; everything else is pushed to stderr so a
 * stray print in a dependency cannot corrupt a frame.
 */
import { Peer } from "../shared/wire";
import { Engine } from "./engine";
import { ThinkingLevel } from "onflip/dist/models";
import { ApprovalMode } from "onflip/dist/agent/permissions";
import { logger } from "onflip/dist/log";

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

// Anything that prints must not print into the protocol stream.
const toStderr =
  (level: string) =>
  (...parts: unknown[]) => {
    try {
      process.stderr.write(`[${level}] ${parts.map(String).join(" ")}\n`);
    } catch {
      /* a broken pipe on a log line is not worth crashing over */
    }
  };
console.log = toStderr("log");
console.info = toStderr("info");
console.warn = toStderr("warn");
console.error = toStderr("error");

// When the parent dies, every write to stdout is EPIPE, and an unhandled
// `error` on the stream becomes an uncaughtException — whose handler below
// writes to stdout again. Swallowed here so the shutdown can finish quietly.
process.stdout.on("error", () => {});
const peer = new Peer((chunk) => process.stdout.write(chunk));
const engine = new Engine(peer, argValue("--cwd") ?? process.cwd());

process.stdin.on("data", (chunk) => peer.feed(chunk));
process.stdin.on("end", () => {
  // Recorded because a parent closing the pipe and a crash look identical
  // from the session log: both just stop. This line is the difference.
  logger.info("session", "parent closed stdin; shutting down");
  void shutdown();
});
process.stdin.resume();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await engine.shutdown();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
// Logged to the session file as well as the renderer panel: the panel dies
// with the window, and a crash investigated the next morning has only the
// file to go on.
process.on("uncaughtException", (e) => {
  logger.error("session", "uncaught exception", { stack: e?.stack ?? String(e) });
  if (!shuttingDown) peer.emit("log", { line: `uncaught: ${e?.stack ?? e}` });
});
process.on("unhandledRejection", (e) => {
  const stack = e instanceof Error ? e.stack : String(e);
  logger.error("session", "unhandled rejection", { stack });
  if (!shuttingDown) peer.emit("log", { line: `unhandled rejection: ${stack}` });
});

peer.onRequest = async (method, rawParams) => {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  switch (method) {
    case "init":
      return engine.init();
    case "send":
      return engine.send(
        String(params.text ?? ""),
        params.attachments as string[] | undefined
      );
    case "interrupt":
      engine.interrupt();
      return null;
    case "clearQueue":
      engine.clearQueue();
      return null;
    case "unqueue":
      return engine.unqueue(String(params.id ?? ""));

    case "newSession":
      return engine.newSession();
    case "listSessions":
      return engine.listSessionSummaries(params.limit as number | undefined);
    case "resumeSession":
      return engine.resumeSession(String(params.id));
    case "peekSession":
      return engine.peekSession(String(params.id));
    case "deleteSession":
      return engine.removeSession(String(params.id));
    case "rollback":
      return engine.rollbackMessage(String(params.messageId));
    case "importBrowserSession":
      return engine.importBrowserSession();
    case "setBrowserViewport":
      return engine.setBrowserViewport(
        Number(params.width),
        Number(params.height),
        params.scale === undefined ? undefined : Number(params.scale)
      );
    case "browserInput":
      return engine.browserInput(params as unknown as Parameters<typeof engine.browserInput>[0]);
    case "applySignOut":
      return engine.applySignOut();
    case "applySignIn":
      return engine.applySignIn(
        (params.cookies as { name: string; value: string }[]) ?? [],
        params.account as { name?: string; email?: string } | undefined
      );
    case "signInBrowserInfo":
      return engine.signInBrowserInfo();
    case "signInWithBrowser":
      return engine.signInWithBrowser();
    case "finishBrowserSignIn":
      return engine.finishBrowserSignIn();
    case "cancelBrowserSignIn":
      return engine.cancelBrowserSignIn();

    case "recentProjects":
      return engine.recentProjectList();
    case "openProject":
      return engine.openProject(String(params.dir));
    case "openScratch":
      return engine.openScratch();
    case "changeCwd":
      return engine.changeCwd(String(params.dir));

    case "listModels":
      return engine.listModelInfos();
    case "refreshModels":
      return engine.refreshModels();
    case "setModel":
      return engine.setModel(String(params.slug));
    case "setThinking":
      return engine.setThinking((params.level ?? null) as ThinkingLevel | null);
    case "setApproval":
      return engine.setApproval(params.mode as ApprovalMode);
    case "setShell":
      return engine.setShell(Boolean(params.enabled));
    case "setNetwork":
      return engine.setNetwork(Boolean(params.enabled));

    case "getConfig":
      return engine.configView();
    case "setConfigValue":
      return engine.setConfigValue(String(params.key), params.value);
    case "setRule":
      return engine.setRule(String(params.pattern), String(params.action));
    case "deleteRule":
      return engine.deleteRule(String(params.pattern));

    case "compact":
      return engine.compactTranscript();
    case "sessionDiff":
      return engine.sessionDiff();
    case "undoPreview":
      return engine.undoPreview();
    case "undo":
      return engine.undoLast();
    case "exportTranscript":
      return engine.exportTranscript();

    case "listChats":
      return engine.listChats(
        params.scope === "all" ? "all" : "project",
        params.query as string | undefined
      );
    case "attachChat":
      return engine.attachChat(String(params.id), params.title as string | undefined);
    case "listChatProjects":
      return engine.listChatProjects();
    case "setChatProject":
      return engine.setChatProject((params.id ?? null) as string | null);
    case "createChatProject":
      return engine.createChatProject(String(params.name));

    case "diagnostics":
      return engine.diagnostics();

    case "doctor":
      return engine.doctor();

    case "deepDoctor":
      return engine.deepDoctor();

    case "status":
      return engine.statusPayload();

    default:
      throw new Error(`Unknown engine method: ${method}`);
  }
};
