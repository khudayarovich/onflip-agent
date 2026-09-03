import { app, net } from "electron";

/**
 * Telling people a new version exists.
 *
 * OnFlip had no way to say so at all: every fix shipped so far reached only
 * the people who happened to visit the releases page again, which is close to
 * nobody — the version that fixed sign-in on a second machine was invisible
 * to exactly the person it was written for.
 *
 * This checks and tells; it does not install. Installing in place needs a
 * signed application, and OnFlip is not signed on either platform yet: an
 * unsigned in-place update on macOS is refused outright by the OS updater,
 * and on Windows it would put the same SmartScreen warning in front of the
 * user that the download page does, only without the context that they asked
 * for it. So the offer is one click to the release, which is honest about
 * what happens next.
 */

const RELEASES_API = "https://api.github.com/repos/khudayarovich/onflip-agent/releases/latest";
const RELEASES_PAGE = "https://github.com/khudayarovich/onflip-agent/releases/latest";

export interface UpdateInfo {
  current: string;
  latest?: string;
  /** The release page, or the direct asset for this platform when there is one. */
  url: string;
  /** True only when `latest` is genuinely newer than what is running. */
  available: boolean;
  /** Set when the check could not be made at all, e.g. no network. */
  error?: string;
}

/** "desktop-v0.7.8" and "v0.7.8" and "0.7.8" all mean the same thing. */
function versionOf(tag: string): string {
  return tag.replace(/^.*?v/, "").trim();
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Numeric per segment, so 0.7.10 sorts after 0.7.9 — which string comparison
 * gets wrong, and which this project will reach.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface GitHubRelease {
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
 * Ask GitHub what the latest release is.
 *
 * Uses Electron's own network stack rather than `fetch` so it follows the
 * system proxy, which is the difference between working and silently never
 * finding an update on a corporate machine.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = net.request({ url: RELEASES_API, method: "GET" });
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
            reject(new Error(`GitHub answered ${response.statusCode}`));
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

    const release = JSON.parse(body) as GitHubRelease;
    const latest = release.tag_name ? versionOf(release.tag_name) : undefined;
    return {
      current,
      latest,
      url: assetFor(release) ?? release.html_url ?? RELEASES_PAGE,
      available: Boolean(latest && !release.draft && !release.prerelease && isNewer(latest, current)),
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
