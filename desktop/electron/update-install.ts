import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, net } from "electron";
import { checkForUpdate, type UpdateInfo } from "./updates";

/**
 * Downloading and applying an update, rather than pointing at a download page.
 *
 * `updates.ts` used to end "this checks and tells; it does not install", and
 * the reason given was that OnFlip is unsigned. That reason turns out to
 * apply to only one of the two mechanisms. What an unsigned build cannot do
 * is use the OS updaters — Squirrel.Mac refuses outright, and Windows' update
 * surfaces want a signed publisher. What it *can* do is exactly what the
 * person would have done by hand: fetch the artifact the release already
 * publishes, and run it.
 *
 * The honest limits are worth stating, because they shape the design:
 *
 *   - The download is not signature-checked, because there is no signature to
 *     check. It arrives over TLS from the same repository the app came from,
 *     and its length is verified against what GitHub said it would be. That
 *     is the same trust as clicking the link, and no more.
 *   - Nothing is applied while the app is running. Both platforms hand off to
 *     a detached process that waits for this one to exit, because replacing
 *     files under a live process is how an update leaves someone with neither
 *     the old version nor the new one.
 */

export type UpdatePhase = "downloading" | "installing" | "error";

export interface UpdateProgress {
  phase: UpdatePhase;
  /** 0–100 while downloading; absent once the bytes are in. */
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
  /** Present when `phase` is "error". */
  message?: string;
}

/** Where a downloaded update waits. Cleared on the way in, not on the way out. */
function stagingDir(): string {
  const dir = path.join(app.getPath("temp"), "onflip-update");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fetch the artifact, reporting progress as it lands.
 *
 * Electron's `net` rather than `fetch`, for the system proxy — an update that
 * silently never downloads on a corporate machine is worse than one that
 * never checks.
 */
export function downloadUpdate(
  url: string,
  name: string,
  onProgress: (p: UpdateProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = path.join(stagingDir(), name);
    const out = fs.createWriteStream(target);
    let received = 0;
    let total = 0;
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(e);
    };

    const request = net.request({ url, method: "GET" });
    request.setHeader("User-Agent", `OnFlip/${app.getVersion()}`);
    // GitHub answers with a 302 to a signed asset URL. Electron follows that
    // itself and emits `response` only for the final hop — but if it ever
    // emitted both, attaching the data handlers twice would double-count
    // every byte and fail the length check on a perfectly good download.
    let receiving = false;
    request.on("response", (response) => {
      if (receiving) return;
      receiving = true;
      const status = response.statusCode ?? 0;
      // GitHub serves release assets from a redirect, which Electron's net
      // follows itself; anything else that is not a 2xx is a real failure.
      if (status >= 400) {
        fail(new Error(`the download answered ${status}`));
        return;
      }
      total = Number(response.headers["content-length"] ?? 0) || 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        out.write(chunk);
        onProgress({
          phase: "downloading",
          receivedBytes: received,
          totalBytes: total || undefined,
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : undefined,
        });
      });
      response.on("error", (e: Error) => fail(e));
      response.on("aborted", () => fail(new Error("the download was interrupted")));
      response.on("end", () => {
        out.end(() => {
          if (settled) return;
          // A truncated installer is worse than none: it would run and fail
          // halfway. The length GitHub promised is the only check available
          // without a signature, so it is the one that gets made.
          if (total && received !== total) {
            settled = true;
            reject(new Error(`the download stopped early (${received} of ${total} bytes)`));
            return;
          }
          settled = true;
          resolve(target);
        });
      });
    });
    request.on("error", (e) => fail(e));
    request.end();
  });
}

/** The macOS hand-off script: wait for this process to go, then swap bundles. */
function macSwapScript(file: string, staging: string, bundle: string, pid: number): string {
  const lines = [
    "#!/bin/sh",
    "set -e",
    // `kill -0` is a liveness probe, not a signal. The ceiling stops a wedged
    // process holding the update up for ever.
    'for i in $(seq 1 60); do kill -0 ' + pid + ' 2>/dev/null || break; sleep 0.5; done',
    'cd "' + staging + '"',
    '/usr/bin/ditto -xk "' + file + '" "' + staging + '/unpacked"',
    'NEW=$(find "' + staging + '/unpacked" -maxdepth 1 -name "*.app" | head -1)',
    // Refuse rather than destroy: with no new bundle, the old one stays put.
    '[ -n "$NEW" ] || exit 1',
    '/bin/rm -rf "' + bundle + '.old"',
    '/bin/mv "' + bundle + '" "' + bundle + '.old"',
    // `ditto` rather than `cp` so extended attributes and symlinks inside the
    // bundle survive. On failure the previous version is put back, because an
    // update that fails must leave a working app rather than none.
    '/usr/bin/ditto "$NEW" "' + bundle + '" || { /bin/mv "' + bundle + '.old" "' + bundle + '"; exit 1; }',
    '/bin/rm -rf "' + bundle + '.old"',
    // Fetched by us over TLS rather than by a browser, so there should be no
    // quarantine flag. Cleared anyway: a stray one on a nested file turns the
    // relaunch into a Gatekeeper prompt.
    '/usr/bin/xattr -dr com.apple.quarantine "' + bundle + '" 2>/dev/null || true',
    '/usr/bin/open "' + bundle + '"',
  ];
  return lines.join("\n") + "\n";
}

/**
 * Hand the downloaded artifact to something that outlives this process.
 *
 * Windows runs the NSIS installer silently. `/S` is what the assisted
 * installer this project builds accepts, and electron-builder's NSIS starts
 * the app again when it finishes — which is why nothing here relaunches it.
 *
 * macOS gets a shell script rather than a disk image: the release publishes a
 * `.zip` holding the `.app` directly, so no image has to be mounted and no
 * window opened.
 *
 * Returns whether the hand-off will bring the app back by itself, so the
 * caller knows whether to say "reopening" or "install it from the window
 * that opens".
 */
export function applyUpdate(file: string): { relaunches: boolean } {
  if (process.platform === "win32") {
    // Detached with stdio ignored, or the installer dies with its parent the
    // moment the app quits — which is the very next thing that happens.
    spawn(file, ["/S"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { relaunches: true };
  }

  if (process.platform === "darwin") {
    // `getAppPath()` points at Contents/Resources/app; the bundle is three up.
    const bundle = path.resolve(app.getAppPath(), "..", "..", "..");
    const staging = path.dirname(file);
    const script = path.join(staging, "apply.sh");
    fs.writeFileSync(script, macSwapScript(file, staging, bundle, process.pid), { mode: 0o755 });
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
    return { relaunches: true };
  }

  // Nothing installable here; the caller falls back to opening the page.
  return { relaunches: false };
}

// ---------------------------------------------------------------------------
// checking on a schedule
// ---------------------------------------------------------------------------

/** Long enough not to be noise, short enough that a fix lands the same day. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
/**
 * The first check waits, deliberately. A launch is the busiest moment the app
 * has — engine spawn, first paint, session restore — and a banner arriving in
 * the middle of it competes with whatever the person opened the app to do.
 */
const FIRST_CHECK_DELAY_MS = 90_000;

let watchTimer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
/** The version already announced, so a six-hourly timer nags once, not forever. */
let announced: string | null = null;

export function startUpdateWatch(onAvailable: (info: UpdateInfo) => void): void {
  if (watchTimer) return;
  const tick = async () => {
    try {
      const info = await checkForUpdate();
      if (!info.available || !info.latest) return;
      if (announced === info.latest) return;
      announced = info.latest;
      onAvailable(info);
    } catch {
      // A failed check is the network's problem, and the next tick retries.
    }
  };
  firstTimer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  firstTimer.unref?.();
  watchTimer = setInterval(tick, UPDATE_INTERVAL_MS);
  watchTimer.unref?.();
}

export function stopUpdateWatch(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (watchTimer) clearInterval(watchTimer);
  firstTimer = null;
  watchTimer = null;
}

/** For tests: forget what has been announced. */
export function __resetAnnouncedForTest(): void {
  announced = null;
}
