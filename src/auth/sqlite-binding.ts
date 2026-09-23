import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Opening sqlite in whatever runtime this process turned out to be.
 *
 * better-sqlite3's own binding is one file, built for one Node ABI on one
 * CPU: the release builds it with Node 22 on the machine running the build.
 * The engine can run under plain Node or under Electron-as-Node, on either
 * kind of Mac, so the package also ships a binding per platform and CPU for
 * Electron's ABI (prebuilds/), and a load that cannot use the default
 * binding falls back to the one that matches this process.
 *
 * "Cannot use" was read as "built for another ABI" only, and that missed a
 * whole kind of machine. The macOS release is built on Apple Silicon, so
 * the Intel app's default binding is arm64 too — found by reading the
 * 0.10.55 zips, and the same in every release back to at least 0.10.40. On
 * an Intel Mac that load fails with "incompatible architecture" before any
 * ABI is compared, the ABI-only test never matched it, and the shipped
 * darwin-x64 binding was never tried: usage counts read zero, and importing
 * a session from Chrome or Firefox failed.
 */

/**
 * The ways a binding says it cannot run in this process at all, as opposed
 * to failing to open a database: built for another ABI, or for another CPU —
 * macOS in both its wordings, Windows, and Linux's ELF loader.
 */
export const BINDING_MISMATCH =
  /NODE_MODULE_VERSION|compiled against a different Node\.js version|incompatible architecture|wrong architecture|not a valid Win32 application|wrong ELF class|ELFCLASS\d+|Exec format error/i;

/** Whether an error is the binding refusing this runtime, not sqlite refusing a file. */
export function isBindingMismatch(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return BINDING_MISMATCH.test(text);
}

/** The shipped binding for this runtime's platform, CPU and ABI, or null when there is none. */
export function bundledSqliteBinding(): string | null {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    `better_sqlite3-abi${process.versions.modules}.node`
  );
  return fs.existsSync(file) ? file : null;
}

/**
 * Open with the default binding, or with the shipped one when the default
 * cannot run here. Any other failure — a missing file, a locked database —
 * is sqlite's answer and is passed on as it came, and so is the original
 * error when nothing was shipped for this runtime.
 */
export function withBundledBinding<T>(
  open: (nativeBinding?: string) => T,
  bundled: () => string | null = bundledSqliteBinding
): T {
  try {
    return open();
  } catch (e) {
    if (!isBindingMismatch(e)) throw e;
    const file = bundled();
    if (!file) throw e;
    return open(file);
  }
}
