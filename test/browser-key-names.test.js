"use strict";

/**
 * A key the model names the way people say it still gets pressed.
 *
 * Playwright's key names are case-sensitive. Live, on this project's own
 * machine: the agent pressed "TAB" while testing a chess page and got
 * `Unknown key: "TAB"` — a failed step and a round trip for a capital letter.
 * Every name below was also pressed for real in Playwright before shipping.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { playwrightKey } = require("../dist/tools/browser");

test("the names models write become the names Playwright knows", () => {
  const cases = {
    TAB: "Tab",
    tab: "Tab",
    ENTER: "Enter",
    return: "Enter",
    ESC: "Escape",
    del: "Delete",
    PAGEDOWN: "PageDown",
    page_down: "PageDown",
    "Page Down": "PageDown",
    pgup: "PageUp",
    up: "ArrowUp",
    DOWN: "ArrowDown",
    arrowleft: "ArrowLeft",
    SPACEBAR: "Space",
    f5: "F5",
    F12: "F12",
  };
  for (const [written, key] of Object.entries(cases)) assert.equal(playwrightKey(written), key, written);
});

test("each part of a chord is named, and a single character is left as written", () => {
  assert.equal(playwrightKey("ctrl+a"), "Control+a");
  assert.equal(playwrightKey("CTRL+SHIFT+TAB"), "Control+Shift+Tab");
  assert.equal(playwrightKey("cmd + c"), "Meta+c");
  assert.equal(playwrightKey("Control+A"), "Control+A", "a capital A is a different press");
  assert.equal(playwrightKey("/"), "/");
});

test("a name the table does not know passes through untouched", () => {
  // Playwright knows more names than the table lists; guessing one would be worse.
  assert.equal(playwrightKey("Digit1"), "Digit1");
  assert.equal(playwrightKey("KeyA"), "KeyA");
  assert.equal(playwrightKey("F24"), "F24", "not one Playwright knows, so not rewritten into one");
});
