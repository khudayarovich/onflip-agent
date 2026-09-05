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
  const db = path.join(configDir(), "browser-profile", "Default", "Network", "Cookies");
  try {
    if (!fs.existsSync(db)) return false;
    const raw = fs.readFileSync(db);
    return raw.includes("__Secure-next-auth.session-token");
  } catch (e) {
    logger.debug("doctor", "could not read the profile cookie store", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export function runDoctor(): DoctorReport {
  const report = runChecks(inspectEnvironment());
  logger.info("doctor", "ran health checks", {
    status: report.status,
    failed: report.checks.filter((c) => c.status !== "ok").map((c) => c.id),
  });
  return report;
}
