import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, configDir } from "../config";
import { cooldownRemainingMs, describeWait } from "./backoff";
import { logger } from "../log";

/**
 * Checks that are *run*, not printed.
 *
 * `diagnostics()` next door is a state dump: it says what the settings are and
 * leaves the reader to spot what is wrong with them. That is the wrong shape
 * for the failures this app actually has. Measured across every session in
 * `~/.onflip/logs`, 17 turns failed and 13 of them were the same thing — the
 * ChatGPT session going away mid-run — and in every case the first anyone knew
 * of it was a red error in the middle of a task that had been working for an
 * hour.
 *
 * Each check here answers a question that can be answered *before* a turn is
 * spent on it, and each one that fails says what to do rather than what is
 * true. The expensive ones — anything that drives the browser — are opt-in,
 * because a health check that costs a page load is one nobody runs.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  /** Stable identifier, for tests and for the UI to key on. */
  id: string;
  /** What was checked, in the user's terms. */
  title: string;
  status: CheckStatus;
  /** One line. On a failure, what to do about it. */
  message: string;
}

export interface DoctorReport {
  checks: Check[];
  /** The worst status present, which is what the UI shows at the top. */
  status: CheckStatus;
}

/** Everything the checks need, injected so they can be tested without a machine. */
export interface DoctorEnvironment {
  platform: string;
  /** Node's module ABI, which the cookie reader's native binding must match. */
  moduleAbi: string;
  /** Set when the app can run the cookie reader on its own runtime. */
  electronPath?: string;
  /** Whether a directory exists and is readable. */
  exists(p: string): boolean;
  /** Bytes free where OnFlip writes, or undefined when it cannot be read. */
  freeBytes(p: string): number | undefined;
  /** Whether a path can be written to. */
  writable(p: string): boolean;
  /** How many session-token cookies the stored jar holds. */
  storedSessionCookies: number;
  /** Whether the browser profile directory has been signed in to. */
  profileSignedIn: boolean;
  /** Milliseconds left on a persisted cooldown. */
  cooldownMs: number;
  /** The account plan, when one has been read. */
  planType?: string;
  /** True when the user signed out in the app. */
  signedOut: boolean;
  /** The browser channel the profile was created with. */
  browserChannel?: string;
}

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus =>
  a === "fail" || b === "fail" ? "fail" : a === "warn" || b === "warn" ? "warn" : "ok";

/** At least this much room before writes start failing in ways that look like bugs. */
const LOW_DISK_BYTES = 200 * 1024 * 1024;

export function runChecks(env: DoctorEnvironment): DoctorReport {
  const checks: Check[] = [];
  const add = (id: string, title: string, status: CheckStatus, message: string) =>
    checks.push({ id, title, status, message });

  // ---- the session, which is what actually breaks -------------------------
  if (env.signedOut) {
    add(
      "session",
      "ChatGPT session",
      "fail",
      "Signed out in the app. Sign in from the account menu before starting a task."
    );
  } else if (env.profileSignedIn) {
    add(
      "session",
      "ChatGPT session",
      "ok",
      env.storedSessionCookies > 0
        ? "The browser profile is signed in, with a stored session held in reserve."
        : "The browser profile is signed in."
    );
  } else if (env.storedSessionCookies > 0) {
    add(
      "session",
      "ChatGPT session",
      "warn",
      "No session in OnFlip's browser profile yet, but a stored one will be put into it on the next launch. If that fails, sign in from the account menu."
    );
  } else {
    add(
      "session",
      "ChatGPT session",
      "fail",
      "No ChatGPT session anywhere. Sign in from the account menu, or import one if you are signed in to ChatGPT in Firefox."
    );
  }

  // ---- the throttle, which is what makes it look broken -------------------
  if (env.cooldownMs > 0) {
    add(
      "cooldown",
      "Rate limit",
      "warn",
      `ChatGPT is cooling this account down — ${describeWait(env.cooldownMs)} left. Sending now would extend it; the next turn will wait it out.`
    );
  } else {
    add("cooldown", "Rate limit", "ok", "No cooldown is running.");
  }

  // ---- the cookie reader, whose failure looks like "no account" -----------
  if (env.electronPath) {
    add("cookie-reader", "Browser import", "ok", "Can run on the app's own runtime, so the ABI always matches.");
  } else {
    add(
      "cookie-reader",
      "Browser import",
      "warn",
      `Will run on whatever Node is on PATH (module ABI ${env.moduleAbi}). If importing a browser session fails, that mismatch is the usual reason — signing in from the account menu needs nothing extra.`
    );
  }

  // ---- the profile, and the browser that can read it ----------------------
  const profile = path.join(configDir(), "browser-profile");
  if (!env.exists(profile)) {
    add(
      "profile",
      "Browser profile",
      env.profileSignedIn ? "warn" : "ok",
      "Not created yet — it appears on the first sign-in."
    );
  } else if (env.browserChannel) {
    add(
      "profile",
      "Browser profile",
      "ok",
      `Created with ${env.browserChannel}, which is the browser that will drive it.`
    );
  } else {
    add(
      "profile",
      "Browser profile",
      "ok",
      "Present. The browser it was created with is chosen automatically."
    );
  }

  // ---- somewhere to write ------------------------------------------------
  const home = configDir();
  if (!env.writable(home)) {
    add(
      "storage",
      "Local storage",
      "fail",
      `${home} is not writable, so sessions, logs and settings cannot be saved. Check the folder's permissions.`
    );
  } else {
    const free = env.freeBytes(home);
    if (free !== undefined && free < LOW_DISK_BYTES) {
      add(
        "storage",
        "Local storage",
        "warn",
        `Only ${Math.round(free / 1024 / 1024)} MB free where OnFlip writes. A browser profile and its logs need more room than that.`
      );
    } else {
      add("storage", "Local storage", "ok", `Writable at ${home}.`);
    }
  }

  // ---- the plan, which decides the context budget -------------------------
  if (env.planType) {
    add("plan", "Account plan", "ok", `Reported as ${env.planType}.`);
  } else {
    add(
      "plan",
      "Account plan",
      "warn",
      "Not read yet, so the context budget is using conservative defaults. It is read on the first turn."
    );
  }

  return { checks, status: checks.reduce((s, c) => worst(s, c.status), "ok" as CheckStatus) };
}

/** Read the real machine into the shape `runChecks` takes. */
export function inspectEnvironment(): DoctorEnvironment {
  const cfg = loadConfig();
  const jar = cfg.sessionCookies ?? [];
  return {
    platform: `${process.platform} ${process.arch} ${os.release()}`,
    moduleAbi: process.versions.modules,
    electronPath: process.env.ONFLIP_ELECTRON_PATH,
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    freeBytes: (p) => {
      try {
        return fs.statfsSync(p).bavail * fs.statfsSync(p).bsize;
      } catch {
        // Not available on every platform or filesystem; absence is not a fault.
        return undefined;
      }
    },
    writable: (p) => {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    storedSessionCookies: jar.filter(
      (c) => /^__Secure-next-auth\.session-token(\.\d+)?$/i.test(c.name) && c.value.length >= 20
    ).length,
    profileSignedIn: profileHasSession(),
    cooldownMs: cooldownRemainingMs(),
    planType: cfg.planType,
    signedOut: cfg.signedOut === true,
    browserChannel: cfg.browserChannel,
  };
}

/**
 * Whether the browser profile on disk holds a ChatGPT session.
 *
 * Read from the profile's cookie database file rather than by launching a
 * browser: the point of a health check is to be cheap enough to run often.
 * Chromium encrypts the *values*, but the cookie names are stored in plain
 * text in the SQLite file, and a name is all this needs.
 */
function profileHasSession(): boolean {
  const profile = path.join(configDir(), "browser-profile");
  // Chromium moved the cookie store under `Network/` around v96, and the
  // layout is otherwise identical on Windows, macOS and Linux. Both are
  // checked because a false "no session here" is the worst answer this can
  // give: it is the one that sends someone to sign in again when they are
  // already signed in, and the doctor is meant to be the thing you trust.
  const candidates = [
    path.join(profile, "Default", "Network", "Cookies"),
    path.join(profile, "Default", "Cookies"),
  ];
  for (const db of candidates) {
    try {
      if (!fs.existsSync(db)) continue;
      // The values are encrypted; the names are not, which is all this needs.
      if (fs.readFileSync(db).includes("__Secure-next-auth.session-token")) return true;
    } catch (e) {
      logger.debug("doctor", "could not read a profile cookie store", {
        db,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return false;
}

/**
 * The offline checks, plus the one that needs the page.
 *
 * Kept separate because it costs a browser launch and a page load, and a
 * health check nobody runs because it is slow is worse than no health check.
 * The live half is read-only — no message, no chat, nothing against the
 * account — and runs on a throwaway page, so it cannot disturb a live
 * conversation. See `checkSelectorsLive`.
 */
export async function runDeepDoctor(
  checkLive: () => Promise<{ ok: boolean; matches: Record<string, number>; detail: string }>
): Promise<DoctorReport> {
  const base = runDoctor();
  let live: Check;
  try {
    const result = await checkLive();
    live = {
      id: "selectors",
      title: "ChatGPT page",
      // A check that could not run is not a check that failed: no network,
      // or a signed-out page, says nothing about whether the selectors are
      // still right.
      status: result.ok ? "ok" : Object.keys(result.matches).length ? "fail" : "warn",
      message: result.detail,
    };
  } catch (e) {
    live = {
      id: "selectors",
      title: "ChatGPT page",
      status: "warn",
      message: `The page could not be checked: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    };
  }
  const checks = [...base.checks, live];
  return { checks, status: checks.reduce((s, c) => worst(s, c.status), "ok" as CheckStatus) };
}

export function runDoctor(): DoctorReport {
  const report = runChecks(inspectEnvironment());
  logger.info("doctor", "ran health checks", {
    status: report.status,
    failed: report.checks.filter((c) => c.status !== "ok").map((c) => c.id),
  });
  return report;
}
