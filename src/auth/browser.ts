import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSafariCookieLocations } from "./safari";

export interface BrowserCookieLocation {
  browser: string;
  localStatePath: string;
  cookieDbPath: string;
}

export interface ChromiumBrowser {
  name: string;
  userDataDir: string;
}

function env(key: string): string | undefined {
  return process.env[key] || undefined;
}

export function chromiumBrowsers(): ChromiumBrowser[] {
  const home = os.homedir();
  let candidates: ChromiumBrowser[];

  if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    candidates = [
      { name: "Chrome", userDataDir: path.join(support, "Google", "Chrome") },
      { name: "Edge", userDataDir: path.join(support, "Microsoft Edge") },
      { name: "Brave", userDataDir: path.join(support, "BraveSoftware", "Brave-Browser") },
      { name: "Chromium", userDataDir: path.join(support, "Chromium") },
      { name: "Vivaldi", userDataDir: path.join(support, "Vivaldi") },
      { name: "Arc", userDataDir: path.join(support, "Arc", "User Data") },
    ];
  } else if (process.platform === "linux") {
    const config = env("XDG_CONFIG_HOME") || path.join(home, ".config");
    candidates = [
      { name: "Chrome", userDataDir: path.join(config, "google-chrome") },
      { name: "Edge", userDataDir: path.join(config, "microsoft-edge") },
      { name: "Brave", userDataDir: path.join(config, "BraveSoftware", "Brave-Browser") },
      { name: "Chromium", userDataDir: path.join(config, "chromium") },
      { name: "Vivaldi", userDataDir: path.join(config, "vivaldi") },
    ];
  } else {
    const local = env("LOCALAPPDATA") || path.join(home, "AppData", "Local");
    candidates = [
      { name: "Chrome", userDataDir: path.join(local, "Google", "Chrome", "User Data") },
      { name: "Edge", userDataDir: path.join(local, "Microsoft", "Edge", "User Data") },
      { name: "Brave", userDataDir: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { name: "Chromium", userDataDir: path.join(local, "Chromium", "User Data") },
      { name: "Vivaldi", userDataDir: path.join(local, "Vivaldi", "User Data") },
      { name: "Arc", userDataDir: path.join(local, "Arc", "User Data") },
    ];
  }
  return candidates.filter((c) => fs.existsSync(path.join(c.userDataDir, "Local State")));
}

export function chromiumProfiles(userDataDir: string): string[] {
  const profiles: string[] = [];
  if (!fs.existsSync(userDataDir)) return profiles;
  for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "Default" && !/^Profile \d+$/.test(entry.name)) continue;
    profiles.push(path.join(userDataDir, entry.name));
  }
  if (profiles.length === 0) profiles.push(path.join(userDataDir, "Default"));
  return profiles;
}

function resolveCookieDb(profileDir: string): string | null {
  const candidates = [
    path.join(profileDir, "Network", "Cookies"),
    path.join(profileDir, "Cookies"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function findChromiumCookieLocations(): BrowserCookieLocation[] {
  const results: BrowserCookieLocation[] = [];
  for (const browser of chromiumBrowsers()) {
    const localState = path.join(browser.userDataDir, "Local State");
    for (const profile of chromiumProfiles(browser.userDataDir)) {
      const db = resolveCookieDb(profile);
      if (db) {
        results.push({ browser: browser.name, localStatePath: localState, cookieDbPath: db });
      }
    }
  }
  return results;
}

export function findFirefoxCookieLocations(): BrowserCookieLocation[] {
  const results: BrowserCookieLocation[] = [];
  const home = os.homedir();
  const firefoxRoot =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Firefox")
      : process.platform === "linux"
        ? path.join(home, ".mozilla", "firefox")
        : path.join(env("APPDATA") || path.join(home, "AppData", "Roaming"), "Mozilla", "Firefox");
  if (!fs.existsSync(firefoxRoot)) return results;

  const profilesIni = path.join(firefoxRoot, "profiles.ini");
  const profileDirs: string[] = [];
  if (fs.existsSync(profilesIni)) {
    let section: string | null = null;
    let currentPath: string | null = null;
    const finalize = () => {
      if (section?.startsWith("Profile") && currentPath) {
        profileDirs.push(currentPath);
      }
      currentPath = null;
    };
    for (const line of fs.readFileSync(profilesIni, "utf8").split(/\r?\n/)) {
      const sec = line.match(/^\[(.+)\]$/);
      if (sec) {
        finalize();
        section = sec[1];
        continue;
      }
      const p = line.match(/^Path=(.*)$/);
      if (p) currentPath = p[1].trim();
    }
    finalize();
  }
  if (profileDirs.length === 0) {
    const profilesRoot = path.join(firefoxRoot, "Profiles");
    if (fs.existsSync(profilesRoot)) {
      for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) profileDirs.push(path.join("Profiles", entry.name));
      }
    }
  }

  for (const rel of profileDirs) {
    const profileAbs = path.isAbsolute(rel) ? rel : path.join(firefoxRoot, rel);
    const db = path.join(profileAbs, "cookies.sqlite");
    if (fs.existsSync(db)) {
      results.push({ browser: "Firefox", localStatePath: "", cookieDbPath: db });
    }
  }
  return results;
}

/**
 * Every browser this platform knows about, whether or not it is installed.
 *
 * The search only reports on browsers it actually found, which reads as
 * silence about the rest: a user whose Firefox is not installed saw a table
 * with no Firefox row and concluded the check had failed. Naming what was
 * looked for turns that into an answer.
 */
export function knownBrowserNames(): string[] {
  const chromium =
    process.platform === "linux"
      ? ["Chrome", "Edge", "Brave", "Chromium", "Vivaldi"]
      : ["Chrome", "Edge", "Brave", "Chromium", "Vivaldi", "Arc"];
  return [...chromium, "Firefox", ...(process.platform === "darwin" ? ["Safari"] : [])];
}

export function allCookieLocations(): BrowserCookieLocation[] {
  // Firefox and Safari first: their stores are readable, so a session there
  // is found without paying for the Chromium attempts that mostly fail.
  return [
    ...findFirefoxCookieLocations(),
    ...findSafariCookieLocations(),
    ...findChromiumCookieLocations(),
  ];
}
