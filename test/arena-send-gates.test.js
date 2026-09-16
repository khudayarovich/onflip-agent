"use strict";

/**
 * The three dialogs and one silent switch standing between a fresh Arena
 * session and its first answer.
 *
 * Reported from a Mac as "message stuck at thinking, still working and
 * sending, no response" - on the machine where the provider was BUILT, the
 * same turns worked, because that machine's profile had already been
 * through all of it. Reproduced on fresh profiles, in order:
 *
 *   The first press of Send does not send. It opens the Terms of Use
 *   dialog - Agree / Close - and holds the message, invisibly in a
 *   headless window.
 *
 *   A fresh session starts in Battle Mode, and Arena rebuilt its menus:
 *   the mode options are plain text rows in a [data-state=open] portal,
 *   with no role=option anywhere - so the old switch scan found nothing,
 *   silently, and Battle Mode's two anonymous answers are not readable.
 *
 *   And Direct mode is now behind an account for guests: a "Log In or
 *   Create Account" dialog appears where the answer would be.
 *
 * These tests hold the driver to knowing all three.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "providers", "arena", "browser.ts"),
  "utf8"
);
const { ACCEPT_TERMS } = require("../dist/providers/arena/browser");

test("the Terms dialog is answered, and scoped to itself", () => {
  // The script must only ever click inside a dialog that says Terms of
  // Use, and only a button that says Agree - a page-wide "click anything
  // agreeing" would accept things nobody asked it to.
  assert.match(ACCEPT_TERMS, /role=dialog/);
  assert.match(ACCEPT_TERMS, /Terms of Use/);
  assert.match(ACCEPT_TERMS, /agree/i);
  assert.ok(
    ACCEPT_TERMS.indexOf("querySelectorAll(\"button\")") > ACCEPT_TERMS.indexOf("Terms of Use"),
    "buttons are searched inside the matched dialog, not the page"
  );
});

test("the held send is retried before the turn is failed", () => {
  // Agreeing releases the held message on Arena's schedule, or not at all
  // - both seen live. So after consent the driver polls for the landing
  // and then presses Send again itself; one look and a throw turns a
  // formality into a failed turn.
  const submit = SRC.slice(SRC.indexOf("const submit"), SRC.indexOf("await submit()"));
  const consent = submit.indexOf("acceptTerms(page)");
  assert.ok(consent !== -1, "the send path answers the Terms dialog");
  assert.ok(
    consent < submit.indexOf('page.keyboard.press("Enter")'),
    "and answers it before falling back to Enter, not after"
  );
  assert.match(submit, /press Send again/i);
});

test("the mode switch is retried, because a cold page ignores the first try", () => {
  // A fresh profile's first load paints the combobox seconds before it
  // works; one pass timed for a warm page left every fresh session in
  // Battle Mode. The costly part is that the failure is silent - nothing
  // throws, the send goes ahead, and the answers are simply unreadable.
  const mode = SRC.slice(SRC.indexOf("export async function setDirectMode"));
  assert.match(mode, /for \(let attempt = 0; attempt < 3/);
  // And the click is believed only when the control re-reads as Direct.
  assert.match(mode, /re-reading the mode/);
});

test("menus without role=option are still menus", () => {
  // Arena rebuilt its dropdowns as plain text rows in a [data-state=open]
  // portal. The driver tries the old role first - other menus may keep it
  // - and then clicks the row by its coordinates, since this menu selects
  // on real pointer events rather than synthetic clicks.
  const clicker = SRC.slice(SRC.indexOf("async function clickMenuRow"), SRC.indexOf("export async function setDirectMode"));
  assert.match(clicker, /role=option/);
  assert.match(clicker, /data-state=open/);
  assert.match(clicker, /mouse\.click/);
});

test("the login wall is named as policy, not reported as a bug", () => {
  // A signed-out session in Direct mode gets "Log In or Create Account"
  // where its answer would be. The generic send failure reads as the app
  // being broken; this one is Arena's rule, and the message says what to
  // do about it. The code matters too: "anonymous" routes to the sign-in
  // flow rather than to a retry that can never work.
  const wall = SRC.indexOf("log in or create account");
  assert.ok(wall !== -1, "the wall dialog is recognised");
  const after = SRC.slice(wall, wall + 800);
  assert.match(after, /"anonymous"/);
  assert.match(after, /sign in to Arena/i);
});

test("Arena's browser is headed everywhere a window can exist", () => {
  // Measured on one signed-in profile, same account, minutes apart:
  // headless, every generation dies server-side with Arena's own
  // "Something went wrong"; headed, the same turn answers in twenty
  // seconds. The send is accepted either way - the kill is silent, at the
  // end, which is what made it read as the app hanging.
  const { arenaWindow } = require("../dist/providers/arena/browser");
  for (const platform of ["win32", "darwin"]) {
    const w = arenaWindow(false, platform);
    assert.equal(w.headless, false, `${platform} must not drive Arena headless`);
    assert.ok(
      w.args.some((a) => a.startsWith("--window-position=-")),
      `${platform}'s window is parked off the desktop`
    );
    assert.ok(
      w.args.includes("--disable-blink-features=AutomationControlled"),
      "the automation flag still rides along"
    );
  }
  // A deliberately headed window is a window someone wants to see.
  const headed = arenaWindow(true, "win32");
  assert.equal(headed.headless, false);
  assert.ok(!headed.args.some((a) => a.startsWith("--window-position=-")));
  // And a box with no display server cannot open a window at all.
  assert.equal(arenaWindow(false, "linux").headless, true);
});

test("a generation that dies is reported in seconds, not minutes", () => {
  // The error card renders outside the reply container, so a killed
  // generation used to sit out the whole silence window - three minutes
  // per attempt, three attempts, ten minutes of "still working". The poll
  // loop now asks the page why the moment a generation ends with nothing
  // written.
  const loop = SRC.slice(SRC.indexOf("let emptyEnds"), SRC.indexOf("if (Date.now() - lastChange > SILENCE_MS)"));
  assert.ok(loop.length > 0, "the empty-end counter exists in the poll loop");
  assert.match(loop, /sawGenerating && !now\.generating && now\.text\.trim\(\)\.length === 0/);
  assert.match(loop, /serviceMessage\(page\)/);
});
