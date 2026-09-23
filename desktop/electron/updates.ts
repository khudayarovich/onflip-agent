import { app, net } from "electron";

/**
 * Telling people a new version exists.
 *
 * OnFlip had no way to say so at all: every fix shipped so far reached only
 * the people who happened to visit the releases page again, which is close to
 * nobody — the version that fixed sign-in on a second machine was invisible
 * to exactly the person it was written for.
 *
 * This finds the release and says what it holds for this machine; fetching
 * and applying it is `update-install.ts`, which does what the person would
 * have done by hand rather than going through an OS updater an unsigned app
 * cannot use (see AGENTS.md, "Being unsigned rules out the OS updaters").
 */

/**
 * The release GitHub calls latest, then — only when that is not a desktop
 * release — the list.
 *
 * This repository publishes the CLI's releases too (`v0.2.0`), and "latest"
 * is whichever release came last: reading it alone, the next CLI release
 * would have been the only one the app ever saw, and no desktop update would
 * have been offered until another desktop release followed it. Reading the
 * list alone fixed that and cost the common case: fifteen releases are
 * nearly 300 KB against 20 KB for one, all inside the same ten seconds, and
 * two checks in one afternoon ran out of them. Latest is a desktop release
 * on almost every check.
 */
const LATEST_API = "https://api.github.com/repos/khudayarovich/onflip-agent/releases/latest";
const RELEASES_API = "https://api.github.com/repos/khudayarovich/onflip-agent/releases?per_page=15";
const RELEASES_PAGE = "https://github.com/khudayarovich/onflip-agent/releases";
/** The desktop app's tags; everything else in the repository is not ours to offer. */
const DESKTOP_TAG = /^desktop-v\d/;

export interface UpdateInfo {
  current: string;
  latest?: string;
  /** The release page, or the direct asset for this platform when there is one. */
  url: string;
  /** True only when `latest` is genuinely newer than what is running. */
  available: boolean;
  /**
   * A newer version exists but its build for this machine is not uploaded
   * yet, so nothing can be offered. The release appears on GitHub minutes
   * before its artifacts do — each platform's build uploads when it
   * finishes — and during that window the app used to show an update button
   * whose click could only open the release page, where the file was
   * missing too. The next check finds the finished release.
   */
  pending?: string;
  /** Set when the check could not be made at all, e.g. no network. */
  error?: string;
  /**
   * The artifact an automatic update would install, when this platform has
   * one. Absent on Linux, and absent when the release did not publish a
   * build for this architecture — in which case the offer falls back to
   * opening `url`, which is what the app did before it could install.
   */
  installable?: {
    url: string;
    name: string;
    /** The checksum listing this release publishes, when it has one. */
    sumsUrl?: string;
  };
}

/**
 * Why an automatic install cannot start, or null when it can.
 *
 * Three different situations used to answer "no installable build for this
 * platform", and only one of them was that. The check re-runs at click time
 * and reaches api.github.com unauthenticated - 60 requests an hour per
 * address, shared with the poll on a timer - so the most common reason for
 * landing on the download page is that this request failed, not that the
 * platform is unsupported. Told the wrong one, someone goes looking for a
 * missing artifact that is sitting right there in the release.
 */
export function whyNotInstallable(
  info: Pick<UpdateInfo, "error" | "available" | "installable" | "pending">,
  platform: string = process.platform,
  arch: string = process.arch
): string | null {
  if (info.error) return `the update check failed: ${info.error}`;
  // Distinct from "no newer release", which it is the opposite of: the
  // release exists and its files are still uploading. Told "you are
  // current", somebody stops looking; told this, they know to come back.
  if (info.pending) return `version ${info.pending} is still being published; try again in a few minutes`;
  if (!info.available) return "no newer release was found";
  if (!info.installable) return `this release has no build for ${platform}/${arch}`;
  return null;
}

/** "desktop-v0.7.8" and "v0.7.8" and "0.7.8" all mean the same thing. */
function versionOf(tag: string): string {
  return tag.replace(/^.*?v/, "").trim();
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Numeric per segment, so 0.7.10 sorts after 0.7.9 — which string comparison
 * gets wrong, and which this project will reach. A pre-release sorts before
 * its release, as semver has it: splitting "0.10.51-rc.1" on dots and dashes
 * made it 0.10.51.0.1, newer than 0.10.51, so anyone running a release
 * candidate was never offered the release itself.
 */
export function isNewer(candidate: string, current: string): boolean {
  const split = (v: string) => {
    const [core, ...pre] = v.trim().replace(/\+.*$/, "").split("-");
    return {
      core: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: pre.length ? pre.join("-").split(".") : [],
    };
  };
  const a = split(candidate);
  const b = split(current);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x > y;
  }
  // Same release: none beats any pre-release, and two pre-releases compare
  // identifier by identifier, numbers numerically and before words.
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return y === undefined;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx > ny;
    if (nx !== null || ny !== null) return ny !== null;
    return x > y;
  }
  return false;
}

/**
 * The desktop release to offer out of a page of the repository's releases:
 * the highest `desktop-v` version that is neither a draft nor a pre-release.
 * Chosen by version rather than by position, so the order GitHub lists them
 * in — creation time — cannot put an older release first.
 */
export function pickDesktopRelease(releases: unknown): GitHubRelease | undefined {
  if (!Array.isArray(releases)) return undefined;
  let best: GitHubRelease | undefined;
  for (const release of releases as GitHubRelease[]) {
    if (!release || typeof release.tag_name !== "string" || !DESKTOP_TAG.test(release.tag_name)) continue;
    if (release.draft || release.prerelease) continue;
    if (!best || isNewer(versionOf(release.tag_name), versionOf(best.tag_name ?? ""))) best = release;
  }
  return best;
}

export interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** The installer for the platform asking, when the release has one. */
function assetFor(release: GitHubRelease): string | undefined {
  const wanted =
    process.platform === "win32"
      ? /\.exe$/i
      : process.platform === "darwin"
        ? new RegExp(`mac-${process.arch === "arm64" ? "arm64" : "x64"}\.dmg$`, "i")
        : null;
  if (!wanted) return undefined;
  return release.assets?.find((a) => a.name && wanted.test(a.name))?.browser_download_url;
}

/**
 * The asset the *installer* wants, which is not always the one a person wants.
 *
 * On macOS a human wants the `.dmg` — it is the familiar drag-to-Applications
 * window. An automatic update wants the `.zip`, because it holds the `.app`
 * bundle directly and needs no disk image mounted, no window opened and no
 * `hdiutil` in the path. Windows uses the same NSIS installer either way.
 */
export function installableAssetFor(
  release: GitHubRelease
): { url: string; name: string; sumsUrl?: string } | undefined {
  const wanted =
    process.platform === "win32"
      ? /\.exe$/i
      : process.platform === "darwin"
        ? new RegExp(`mac-${process.arch === "arm64" ? "arm64" : "x64"}\\.zip$`, "i")
        : null;
  if (!wanted) return undefined;
  const hit = release.assets?.find((a) => a.name && wanted.test(a.name));
  if (!hit?.browser_download_url || !hit.name) return undefined;

  // The checksum list this release already publishes — and which, until an
  // audit pointed it out, was written, uploaded and never read by anything.
  //
  // Its limits are worth stating exactly, because it is easy to mistake for
  // more than it is. It lives in the same release as the artifact, so anyone
  // able to swap one could swap both: it is no defence against a compromised
  // release. What it does catch is a truncated or corrupted download, a
  // proxy or mirror serving something else, and an artifact that came from a
  // different release than the one being installed. That is worth one small
  // request, and it is the difference between a length check and a content
  // check.
  //
  // The real defence is a signature made with a key that is not in the
  // release, which needs a Developer ID certificate this project does not
  // have. That is a purchase, not a patch, and it is not pretended here.
  const sumsName = process.platform === "win32" ? "SHA256SUMS-windows.txt" : "SHA256SUMS-macos.txt";
  const sums = release.assets?.find((a) => a.name === sumsName);
  return { url: hit.browser_download_url, name: hit.name, sumsUrl: sums?.browser_download_url };
}

/**
 * Is this release finished being published, as far as this machine cares?
 *
 * A release and its artifacts do not appear together: the release exists on
 * GitHub the moment the first platform's build finishes, and the other
 * platform's files land minutes later. Reported exactly as that reads from
 * the outside — the app announced an update whose button could only open a
 * release page with the file still missing from it.
 *
 * On the platforms with automatic installs, done means this machine's
 * artifact is uploaded AND the checksum list beside it. Every release ships
 * that list, and the verifier only waves a download through unchecked when
 * a release has none — a tolerance meant for old releases, which a
 * half-uploaded new one should not slip through on. Anywhere else there is
 * never an artifact to wait for, and the old rule stands.
 */
export function releaseReadyFor(
  installable: { sumsUrl?: string } | undefined,
  platform: string = process.platform
): boolean {
  if (platform !== "win32" && platform !== "darwin") return true;
  return Boolean(installable?.sumsUrl);
}

/**
 * Ask GitHub what the latest release is.
 *
 * Uses Electron's own network stack rather than `fetch` so it follows the
 * system proxy, which is the difference between working and silently never
 * finding an update on a corporate machine.
 */
/** GitHub answered, and the answer was an error: asking again says the same. */
class GitHubAnswer extends Error {}

/** One GET against the GitHub API, read whole within ten seconds. */
function getOnce(url: string, current: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = net.request({ url, method: "GET" });
    request.setHeader("Accept", "application/vnd.github+json");
    request.setHeader("User-Agent", `OnFlip/${current}`);
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error("timed out"));
    }, 10_000);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      // A body that dies mid-stream is an `error` on the response, and an
      // unhandled one is an exception in the main process.
      response.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
      response.on("aborted", () => {
        clearTimeout(timer);
        reject(new Error("the connection was closed"));
      });
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        clearTimeout(timer);
        if ((response.statusCode ?? 0) >= 400) {
          reject(new GitHubAnswer(`GitHub answered ${response.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    request.end();
  });
}

/**
 * A GitHub API answer, parsed. A stall, a dropped connection or a truncated
 * body is tried once more, because a missed check waits hours for the next
 * one; an answer GitHub gave on purpose — a rate limit, a 404 — is not.
 */
async function getJson(url: string, current: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(await getOnce(url, current));
    } catch (e) {
      if (attempt >= 2 || e instanceof GitHubAnswer) throw e;
    }
  }
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  try {
    let release = pickDesktopRelease([await getJson(LATEST_API, current)]);
    if (!release) {
      const listed = await getJson(RELEASES_API, current);
      if (!Array.isArray(listed)) throw new Error("GitHub did not answer with a list of releases");
      release = pickDesktopRelease(listed);
    }
    release ??= {};
    const latest = release.tag_name ? versionOf(release.tag_name) : undefined;
    const newer = Boolean(latest && isNewer(latest, current));
    const installable = installableAssetFor(release);
    const complete = releaseReadyFor(installable);
    return {
      current,
      latest,
      url: assetFor(release) ?? release.html_url ?? RELEASES_PAGE,
      available: newer && complete,
      pending: newer && !complete ? latest : undefined,
      installable,
    };
  } catch (e) {
    // A failed check is not worth a dialog. It is worth saying so in About,
    // where someone went looking on purpose.
    return {
      current,
      url: RELEASES_PAGE,
      available: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
