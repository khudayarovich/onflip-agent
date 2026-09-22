import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
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

/**
 * How long a download may go without a byte before it is called stalled.
 *
 * There was no limit at all: a connection that stopped answering left the
 * modal on "downloading" for ever, with the button disabled behind it and
 * no way out but quitting. Overridable so a test can see it fire.
 */
function stallMs(): number {
  return Number(process.env.ONFLIP_UPDATE_STALL_MS) || 60_000;
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
    let stall: NodeJS.Timeout | null = null;
    const request = net.request({ url, method: "GET" });
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      if (stall) clearTimeout(stall);
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      out.destroy();
      reject(e);
    };
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(
        () => fail(new Error(`the download stalled: nothing arrived for ${Math.round(stallMs() / 1000)} seconds`)),
        stallMs()
      );
    };
    // A full disk, an antivirus lock, a folder that vanished: the stream
    // says so with an `error` event, and with no listener that was an
    // uncaught exception in the main process and a promise that never
    // settled.
    out.on("error", (e) => fail(e));

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
        if (settled) return;
        armStall();
        received += chunk.length;
        // Held to the disk's pace rather than buffered: an installer is
        // large, and a slow disk behind a fast line would hold all of it in
        // memory.
        if (!out.write(chunk)) {
          // A Readable at runtime; Electron's typings leave the flow
          // control off.
          const flow = response as unknown as { pause?: () => void; resume?: () => void };
          flow.pause?.();
          out.once("drain", () => flow.resume?.());
        }
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
        if (stall) clearTimeout(stall);
        // The callback is where a failed write reports first — before the
        // stream's own `error` event — so its argument is read, not ignored.
        out.end((err?: Error | null) => {
          if (err) fail(err);
          if (settled) return;
          // A truncated installer is worse than none: it would run and fail
          // halfway. The length GitHub promised is the only check available
          // without a signature, so it is the one that gets made.
          if (total && received !== total) {
            settled = true;
            reject(new Error(`the download stopped early (${received} of ${total} bytes)`));
            return;
          }
          // What reached the disk, not what arrived: the two differ exactly
          // when a write went wrong.
          if (out.bytesWritten !== received) {
            settled = true;
            reject(new Error(`the download could not be written in full (${out.bytesWritten} of ${received} bytes)`));
            return;
          }
          settled = true;
          resolve(target);
        });
      });
    });
    request.on("error", (e) => fail(e));
    request.end();
    armStall();
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
 * installer this project builds accepts. A silent electron-builder install
 * starts the app again only when told to with `--force-run` — without it
 * the update installed and nothing came back, which read as the update
 * having closed the app — and `--updated` marks it as an update rather than
 * a fresh install, as electron-updater passes both.
 *
 * macOS gets a shell script rather than a disk image: the release publishes a
 * `.zip` holding the `.app` directly, so no image has to be mounted and no
 * window opened.
 *
 * Returns whether the hand-off will bring the app back by itself, so the
 * caller knows whether to say "reopening" or "install it from the window
 * that opens".
 */
export const WINDOWS_INSTALLER_ARGS = ["--updated", "/S", "--force-run"];

export async function applyUpdate(file: string): Promise<{ relaunches: boolean }> {
  if (process.platform === "win32") {
    // Detached with stdio ignored, or the installer dies with its parent the
    // moment the app quits — which is the very next thing that happens.
    await started(spawn(file, WINDOWS_INSTALLER_ARGS, { detached: true, stdio: "ignore", windowsHide: true }));
    return { relaunches: true };
  }

  if (process.platform === "darwin") {
    // `getAppPath()` points at Contents/Resources/app; the bundle is three up.
    const bundle = path.resolve(app.getAppPath(), "..", "..", "..");
    const staging = path.dirname(file);
    const script = path.join(staging, "apply.sh");
    fs.writeFileSync(script, macSwapScript(file, staging, bundle, process.pid), { mode: 0o755 });
    await started(spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }));
    return { relaunches: true };
  }

  // Nothing installable here; the caller falls back to opening the page.
  return { relaunches: false };
}

/**
 * Resolve once the hand-off process is really running.
 *
 * It was reported started the moment `spawn` returned, and the app quit a
 * second later — so an installer the system refused to launch (antivirus
 * holding an unsigned exe, most often) was an uncaught exception in the
 * main process and an app that closed with no update behind it. A failure
 * here keeps the app open and says why.
 */
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", (e) => reject(new Error(`the installer could not be started: ${e.message}`)));
  });
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

/**
 * Offer `info` unless it has been offered already, and remember it only
 * once someone was told.
 *
 * `deliver` answers whether a window took the offer. The version used to be
 * marked before delivery, so a check that found no window open — the app
 * living in the tray — spent the announcement on nobody, while the log line
 * beside it promised to offer it again later.
 */
export function announce(info: UpdateInfo, deliver: (info: UpdateInfo) => boolean): boolean {
  if (!info.available || !info.latest) return false;
  if (announced === info.latest) return false;
  if (!deliver(info)) return false;
  announced = info.latest;
  return true;
}

export function startUpdateWatch(onAvailable: (info: UpdateInfo) => boolean): void {
  if (watchTimer) return;
  const tick = async () => {
    try {
      announce(await checkForUpdate(), onAvailable);
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

/**
 * The published checksum for one file, out of a `sha256sum` listing.
 *
 * The format is what `sha256sum` and `shasum -a 256` emit: a hex digest, two
 * spaces, the file name, one per line. Pure, so the parsing can be held
 * against the real listings this project publishes without a network.
 *
 * Returns null when the file is not named in the list, which is not the same
 * as a mismatch — a release that never published a sum for this artifact has
 * nothing to disagree with.
 */
export function sumFor(listing: string, name: string): string | null {
  for (const line of (listing ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (!m) continue;
    // Some tools write a path; only the base name is ever compared.
    const listed = m[2].split(/[\\/]/).pop();
    if (listed === name) return m[1].toLowerCase();
  }
  return null;
}

/** The SHA-256 of a file on disk, lowercase hex. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Fetch a small text asset, such as a checksum listing. */
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "follow" });
    // A listing is a few hundred bytes; a minute without one is a stall.
    const timer = setTimeout(() => {
      fail(new Error("the checksum list did not arrive"));
      request.abort();
    }, stallMs());
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        fail(new Error(`the checksum list answered ${status}`));
        return;
      }
      let text = "";
      response.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        // A checksum listing is a few hundred bytes. Anything large is not
        // one, and is not going to be read into memory to find out.
        if (text.length > 64_000) {
          fail(new Error("the checksum list was far larger than one should be"));
          request.abort();
        }
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve(text);
      });
      response.on("error", fail);
    });
    request.on("error", fail);
    request.end();
  });
}

/**
 * Hold a downloaded artifact against the checksum the release published.
 *
 * Throws when they disagree. A release with no listing, or no entry for
 * this file, is reported and allowed: those are older releases, and refusing
 * them would strand anyone on one rather than protect them.
 *
 * A listing the release *did* publish but that cannot be fetched also stops
 * the install. It used to be noted and waved through — so anything able to
 * block one small request (a proxy, a captive portal, a 503) turned the
 * check off, exactly when a substituted download is likeliest. Nothing is
 * lost by refusing: the next attempt fetches it again.
 */
export async function verifyDownload(
  file: string,
  name: string,
  sumsUrl: string | undefined,
  note: (line: string) => void,
  /**
   * How the listing is fetched. Injectable so the rule that matters — a
   * mismatch refuses the install — can be tested without a network, which is
   * the difference between a test of the logic and a test of GitHub.
   */
  fetcher: (url: string) => Promise<string> = fetchText
): Promise<void> {
  if (!sumsUrl) {
    note("this release published no checksum list; installing on the download alone");
    return;
  }
  let listing: string;
  try {
    listing = await fetcher(sumsUrl);
  } catch (e) {
    throw new Error(
      `the checksum list this release published could not be fetched ` +
        `(${e instanceof Error ? e.message : String(e)}). Nothing was installed; try again in a moment.`
    );
  }
  const expected = sumFor(listing, name);
  if (!expected) {
    note(`the checksum list does not name ${name}; installing on the download alone`);
    return;
  }
  const actual = await sha256File(file);
  if (actual !== expected) {
    throw new Error(
      `the downloaded file does not match the checksum this release published ` +
        `(expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…). Nothing was installed.`
    );
  }
  note(`checksum verified (${expected.slice(0, 16)}…)`);
}
