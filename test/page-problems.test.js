"use strict";

/**
 * The page's console, as the agent's browser reports it.
 *
 * Reported: OnFlip builds a web page, starts it and finishes without ever
 * checking that it runs — and the snapshot it could have checked with had no
 * console in it, so a page that threw on its first line read as a page with
 * nothing on it yet. These are the rules for what gets reported: only this
 * machine's own pages, each problem once with a count, where it happened in a
 * form the agent can open, and never more than a snapshot can carry.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { ProblemLog, MAX_REPORTED, isOwnPage, place, problemSection, stackLocation } = require("../dist/tools/page-problems");

const GAME = path.join(os.tmpdir(), "onflip-game", "app.js");
const GAME_URL = pathToFileURL(GAME).href;

test("the pages worth reporting are the ones on this machine", () => {
  for (const url of [GAME_URL, "http://localhost:5173/", "http://127.0.0.1:8000/index.html", "http://[::1]:3000/", "http://chess.localhost/"]) {
    assert.equal(isOwnPage(url), true, url);
  }
  for (const url of ["https://example.com/", "https://github.com/x/y", "about:blank", "data:text/html,hi", "", "not a url"]) {
    assert.equal(isOwnPage(url), false, url);
  }
});

test("an exception is placed at the first frame that names a script", () => {
  const stack = [
    "TypeError: Cannot read properties of null (reading 'getContext')",
    "    at draw (http://localhost:5173/src/board.js:12:18)",
    "    at http://localhost:5173/src/main.js:40:3",
  ].join("\n");
  assert.deepEqual(stackLocation(stack), { url: "http://localhost:5173/src/board.js", line: 12, column: 18 });
  // An anonymous frame.
  assert.deepEqual(stackLocation(`Error: x\n    at ${GAME_URL}:7:1`), { url: GAME_URL, line: 7, column: 1 });
  // Native frames and nothing at all give no place rather than a wrong one.
  assert.equal(stackLocation("Error: x\n    at Array.forEach (<anonymous>)"), undefined);
  assert.equal(stackLocation(undefined), undefined);
});

test("a position is 1-based text, a file is named as the agent names it, and an unknown line is left out", () => {
  assert.equal(place(GAME_URL, 3, 5), `${GAME}:3:5`);
  assert.equal(place(GAME_URL, 3, 5, path.dirname(GAME)), "app.js:3:5");
  // Outside the working folder it keeps its whole path rather than a "../".
  assert.equal(place(GAME_URL, 3, 5, path.join(os.tmpdir(), "elsewhere")), `${GAME}:3:5`);
  assert.equal(place("http://localhost:5173/style.css", 0, 0), "http://localhost:5173/style.css");
  assert.equal(place(""), undefined);
});

test("a problem seen again is counted, not repeated", () => {
  const log = new ProblemLog();
  for (let i = 0; i < 57; i++) {
    log.add({ kind: "exception", text: "TypeError: board is null", url: GAME_URL, line: 1, column: 1 }, GAME_URL);
  }
  log.add({ kind: "console", text: "boom", url: "http://localhost:5173/b.js", line: 2, column: 2 }, "http://localhost:5173/");
  assert.deepEqual(log.drain(path.dirname(GAME)), [
    "Uncaught TypeError: board is null — app.js:1:1 (×57)",
    "boom — http://localhost:5173/b.js:2:2",
  ]);
  // Drained is forgotten.
  assert.deepEqual(log.drain(), []);
});

test("other people's pages are not recorded at all", () => {
  const log = new ProblemLog();
  log.add({ kind: "console", text: "blocked by an ad blocker" }, "https://news.example/");
  assert.equal(log.size, 0);
});

test("a snapshot carries so many lines and counts the rest", () => {
  const log = new ProblemLog();
  for (let i = 0; i < MAX_REPORTED + 5; i++) log.add({ kind: "console", text: `error ${i}` }, "http://localhost:3000/");
  const lines = log.drain();
  assert.equal(lines.length, MAX_REPORTED + 1);
  assert.equal(lines[lines.length - 1], "… and 5 more");
  // A single message cannot be the whole snapshot either.
  log.add({ kind: "console", text: "x".repeat(5_000) }, "http://localhost:3000/");
  assert.ok(log.drain()[0].length <= 300);
  // Already-uncaught text is not called uncaught twice.
  log.add({ kind: "exception", text: "Uncaught (in promise) Error: nope" }, "http://localhost:3000/");
  assert.deepEqual(log.drain(), ["Uncaught (in promise) Error: nope"]);
});

test("the section says 'none' for this machine's page and nothing for anyone else's", () => {
  assert.equal(problemSection([], "http://localhost:5173/"), "console errors since the last snapshot: none");
  assert.equal(problemSection([], "https://example.com/"), null);
  assert.equal(
    problemSection(["boom"], "http://localhost:5173/"),
    "console errors since the last snapshot (1):\n  boom"
  );
});
