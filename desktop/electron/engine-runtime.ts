import { execFileSync } from "node:child_process";

/**
 * Which runtime the engine child runs on.
 *
 * Plain Node is preferred, and the reason is one native module:
 * better-sqlite3, whose binding is compiled for one Node ABI. The installer
 * is built on Node 22, so it ships a binding for ABI 127, plus a second one
 * for Electron's own ABI in `onflip/prebuilds`. The engine was started with
 * whatever `node` the machine had. On a machine with Node 24 (ABI 137) the
 * usage store could never open — every count read zero, and a warning was
 * logged every five seconds for the life of the app — because neither
 * shipped binding fits that runtime.
 *
 * So the machine's Node is asked, once, whether it can open the binding the
 * app ships: exactly the load the engine will do, fallback included. If it
 * cannot, the engine runs under Electron-as-Node, the path machines with no
 * Node at all already take, whose ABI is known when the app is built.
 */

export type SqliteProbe =
  /** The machine's Node opened the shipped binding. */
  | "ok"
  /** It is compiled for another ABI, and no shipped binding fits. */
  | "mismatch"
  /** There is no Node to ask. */
  | "no-node"
  /** Something else went wrong; keep the behaviour that preceded this. */
  | "unknown";

/**
 * The load the engine will do, run under the machine's Node.
 *
 * argv[1] is the engine's directory, which decides which better-sqlite3 is
 * resolved; argv[2] is the onflip package, whose prebuilds are the fallback
 * `bundledSqliteBinding` reaches for.
 */
const PROBE = `
const path = require("path");
const [engineDir, onflipDir] = process.argv.slice(1);
const abi = (e) => /NODE_MODULE_VERSION|compiled against a different Node\\.js version/.test(String(e && e.message));
let Database;
try {
  Database = require(require.resolve("better-sqlite3", { paths: [engineDir] }));
} catch (e) {
  process.stdout.write(abi(e) ? "mismatch" : "unknown");
  process.exit(0);
}
try {
  new Database(":memory:").close();
  process.stdout.write("ok");
} catch (e) {
  if (!abi(e)) {
    process.stdout.write("unknown");
    process.exit(0);
  }
  const shipped = path.join(onflipDir, "prebuilds", process.platform + "-" + process.arch,
    "better_sqlite3-abi" + process.versions.modules + ".node");
  try {
    new Database(":memory:", { nativeBinding: shipped }).close();
    process.stdout.write("ok");
  } catch (e2) {
    process.stdout.write("mismatch");
  }
}
`;

export function probeSystemNode(nodeBin: string, engineDir: string, onflipDir: string): SqliteProbe {
  try {
    const out = execFileSync(nodeBin, ["-e", PROBE, engineDir, onflipDir], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out === "ok" || out === "mismatch" ? out : "unknown";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "no-node" : "unknown";
  }
}

/**
 * The decision, apart from the asking.
 *
 * An explicit `ONFLIP_NODE` is the person's choice and is not second-guessed.
 * Anything the probe could not make sense of keeps plain Node, which is what
 * every build before this one did.
 */
export function engineRuntime(override: string | undefined, probe: () => SqliteProbe): "node" | "electron" {
  if (override) return "node";
  const verdict = probe();
  return verdict === "mismatch" || verdict === "no-node" ? "electron" : "node";
}
