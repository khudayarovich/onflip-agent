import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  const local = env("LOCALAPPDATA") || path.join(os.homedir(), "AppData", "Local");
  const candidates: ChromiumBrowser[] = [
    { name: "Chrome", userDataDir: path.join(local, "Google", "Chrome", "User Data") },
    { name: "Edge", userDataDir: path.join(local, "Microsoft", "Edge", "User Data") },
    { name: "Brave", userDataDir: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
    { name: "Chromium", userDataDir: path.join(local, "Chromium", "User Data") },
    { name: "Vivaldi", userDataDir: path.join(local, "Vivaldi", "User Data") },
    { name: "Arc", userDataDir: path.join(local, "Arc", "User Data") },
  ];
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
  const appData = env("APPDATA") || path.join(os.homedir(), "AppData", "Roaming");
  const firefoxRoot = path.join(appData, "Mozilla", "Firefox");
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

export function allCookieLocations(): BrowserCookieLocation[] {
  return [...findChromiumCookieLocations(), ...findFirefoxCookieLocations()];
}
