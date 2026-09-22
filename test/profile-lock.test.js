"use strict";

/**
 * Taking back a browser profile that a previous browser is still holding.
 *
 * Chromium allows one process per `--user-data-dir` and enforces it with a
 * lock. A second launch on a held directory does not wait — it fails, and
 * Playwright reports "Failed to create a ProcessSingleton for your profile
 * directory".
 *
 * Which is precisely what OnFlip's sign-in does: open a real Chrome on the
 * provider's profile so somebody can log in, close it, then open the same
 * directory with Playwright to read the session back. Reported from a Mac,
 * right after a successful sign-in — and on a Mac it is the expected case
 * rather than bad luck, because closing a window there does not quit the
 * application. The sign-in Chrome is alive in the Dock, holding the lock,
 * while OnFlip is told it cannot check the session.
 *
 * The lock names its owner, so the owner can be checked and the profile
 * freed. Getting that name wrong is the part worth testing: it decides which
 * process id gets signalled.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pidFromLockTarget, releaseProfileLock } = require("../dist/providers/profile-lock");

test("the pid is the last field, because a hostname may contain dashes", () => {
  // The machine this was reported from is called "iMays-Mac-mini". Its lock
  // is one lock, not four, and a naive split on "-" signals process 4821 or
  // nothing at all depending on which end it reads from.
  assert.equal(pidFromLockTarget("iMays-Mac-mini-4821"), 4821);
  assert.equal(pidFromLockTarget("localhost-123"), 123);
  assert.equal(pidFromLockTarget("a-b-c-d-e-99999"), 99999);
});

test("anything that does not name a pid names nothing", () => {
  // A signal sent to a number parsed out of a string that had none is the
  // worst available outcome here: it is somebody else's process.
  for (const junk of ["", "   ", "hostname", "hostname-", "hostname-abc", "-", "host-0", "host--"]) {
    assert.equal(pidFromLockTarget(junk), null, JSON.stringify(junk));
  }
  assert.equal(pidFromLockTarget(null), null);
  assert.equal(pidFromLockTarget(undefined), null);
});

test("a profile with no lock is left completely alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-none-"));
  try {
    fs.writeFileSync(path.join(dir, "Local State"), "{}");
    assert.equal(await releaseProfileLock(dir), "free");
    // Nothing invented, nothing removed.
    assert.ok(fs.existsSync(path.join(dir, "Local State")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create Chromium's lock as a link this OS will actually allow.
 *
 * A plain file symlink needs privileges on Windows, which would mean the
 * POSIX branch is only ever exercised on the machines that suffer from it -
 * the exact arrangement that let every macOS fault in this driver ship. A
 * junction needs no privileges and `readlink` reads it, so the branch runs
 * here too. The target comes back as an absolute path, which is fine: the
 * pid is parsed from the end.
 */
function makeLock(dir, targetName) {
  const link = path.join(dir, "SingletonLock");
  try {
    fs.symlinkSync(targetName, link);
    return true;
  } catch {
    /* no privilege for a file symlink; try a junction */
  }
  try {
    const target = path.join(dir, targetName);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

test("a lock whose owner is gone is cleared away", async (t) => {
  // Run with the POSIX branch forced, so this is exercised on the machine
  // that builds rather than only on the machine that suffers. Every macOS
  // fault in this driver's history was shipped by someone who could not run
  // the macOS branch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-stale-"));
  try {
    // A pid that cannot be running: the graceful close sends SIGKILL after
    // ten seconds, which skips Chromium's own cleanup and strands the lock.
    if (!makeLock(dir, `${os.hostname()}-2147483646`)) return t.skip("no link this OS allows");
    fs.writeFileSync(path.join(dir, "SingletonCookie"), "");

    const said = [];
    const outcome = await releaseProfileLock(dir, (m) => said.push(m), "darwin");

    assert.equal(outcome, "released");
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
    assert.equal(fs.existsSync(path.join(dir, "SingletonCookie")), false);
    assert.ok(said.some((m) => /stale profile lock/.test(m)), said.join(" | "));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock naming no pid at all is still cleared, not left to block a launch", async (t) => {
  // A truncated or rewritten target is not a reason to leave a lock that
  // would refuse the next launch. Nothing is signalled, because nothing was
  // named.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-junk-"));
  try {
    if (!makeLock(dir, "not-a-pid")) return t.skip("no link this OS allows");

    assert.equal(await releaseProfileLock(dir, undefined, "darwin"), "released");
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live owner is signalled, and the profile freed once it goes", async (t) => {
  // The macOS case the report came from: the sign-in Chrome is still running
  // because closing its window did not quit it. The owner is a browser
  // OnFlip started on its own private profile, so ending it is safe - and it
  // is the only way the read that follows a sign-in can succeed.
  const { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-live-"));
  // It names the profile the way the browser holding it does.
  const args = ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${dir}`];
  const child = spawn(process.execPath, args, { stdio: "ignore" });
  // The process table is read through an injected probe here, because this
  // runs the macOS branch on whatever machine builds; the real one is below.
  const inspect = {
    hostname: () => os.hostname(),
    commandLine: (pid) => (pid === child.pid ? `${process.execPath} ${args.join(" ")}` : null),
  };
  try {
    await new Promise((r) => setTimeout(r, 300));
    if (!makeLock(dir, `${os.hostname()}-${child.pid}`)) return t.skip("no link this OS allows");

    const said = [];
    const outcome = await releaseProfileLock(dir, (m) => said.push(m), "darwin", inspect);

    assert.equal(outcome, "released");
    assert.ok(said.some((m) => /still holding the profile/.test(m)), said.join(" | "));
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
    // Liveness directly, not `child.killed` - that flag only reflects a
    // kill made through this handle, and the point is that the lock's owner
    // was signalled by pid, the way it will be for a browser we did not
    // spawn from this process.
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, false, "the process holding the lock is still running");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live process that is not this profile's browser is never signalled", async (t) => {
  // A lock outliving a reboot names a pid that now belongs to something
  // else of the user's. It used to get SIGTERM, then SIGKILL.
  const { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-other-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const inspect = {
    hostname: () => os.hostname(),
    commandLine: (pid) => (pid === child.pid ? `${process.execPath} -e setTimeout(() => {}, 60000)` : null),
  };
  try {
    await new Promise((r) => setTimeout(r, 300));
    if (!makeLock(dir, `${os.hostname()}-${child.pid}`)) return t.skip("no link this OS allows");
    const outcome = await releaseProfileLock(dir, undefined, "darwin", inspect);
    assert.equal(outcome, "released", "the stale lock still goes");
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, "an unrelated process was killed");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left under another machine name signals nothing here", async (t) => {
  const { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-host-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${dir}`], { stdio: "ignore" });
  const inspect = { hostname: () => os.hostname(), commandLine: () => `chrome --user-data-dir=${dir}` };
  try {
    await new Promise((r) => setTimeout(r, 300));
    if (!makeLock(dir, `some-other-machine-${child.pid}`)) return t.skip("no link this OS allows");
    assert.equal(await releaseProfileLock(dir, undefined, "darwin", inspect), "released");
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, "a pid from another machine was signalled here");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the real process table is read where there is one", { skip: process.platform === "win32" ? "POSIX only" : false }, async () => {
  const { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-real-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${dir}`], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(dir, "SingletonLock"));
    assert.equal(await releaseProfileLock(dir), "released");
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.equal(alive, false, "the browser holding this profile was not closed");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows is left to its own devices", { skip: process.platform !== "win32" ? "Windows only" : false }, async () => {
  // Its lock carries no process id, so there is nothing to check liveness
  // against — and deleting a lock whose owner is alive corrupts a profile
  // rather than opening it. The failure is also far rarer there, because
  // closing the window ends the process.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-lock-win-"));
  try {
    fs.writeFileSync(path.join(dir, "lockfile"), "");
    assert.equal(await releaseProfileLock(dir), "free");
    assert.ok(fs.existsSync(path.join(dir, "lockfile")), "the lockfile must not be touched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the message for a held profile says what to do about it", () => {
  // What this replaced, verbatim from the screenshot: "Failed to create a
  // ProcessSingleton for your profile directory. This usually means that the
  // profile is )" — Chromium's sentence cut at 140 characters, severed
  // exactly where it was about to explain, with a stray bracket after it.
  const { profileReadFailure } = require("../dist/providers/qwen/signin");

  const held = profileReadFailure(
    "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory."
  );
  assert.match(held, /still using/i);
  assert.match(held, /quit Chrome/i);
  // The macOS half is the whole point: closing the window is not quitting.
  assert.match(held, /closing the window is not enough/i);
  assert.ok(!/\)\.$/.test(held), "no severed parenthetical");

  // Anything else still reports what actually happened.
  const other = profileReadFailure("browserType.launchPersistentContext: Timeout 30000ms exceeded.");
  assert.match(other, /Timeout 30000ms exceeded/);
});
