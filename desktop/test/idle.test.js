"use strict";

/**
 * An app left open goes quiet, then closes the service's browser, and
 * wakes when the window comes back.
 *
 * The session watch asked DeepSeek or Qwen about the session every three
 * minutes for as long as the window stayed open — all night, if it stayed
 * open all night — from a headless browser that kept the service's page
 * running for nobody. The rules are pure and tested first; then the built
 * Engine is driven with the service stubbed, because the parts that matter
 * are the ones between the rules: a message sent while the browser is
 * closing, and a focus event that must not become a request every time.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist", "engine", "engine.js");
const IDLE = path.join(__dirname, "..", "dist", "engine", "idle.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-idle-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "deepseek";

const MIN = 60_000;
const DONE = "```onflip\ntool: done\nsummary: |\n  finished\n```";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = (over) => ({ busy: false, watching: true, parked: false, ...over });

test("in use the watch checks; unused it goes quiet, then parks once", { skip: needsBuild }, () => {
  const { idleStep, IDLE_QUIET_MS, IDLE_PARK_MS } = require(IDLE);
  assert.equal(idleStep(5 * MIN, state()), "check");
  assert.equal(idleStep(5 * MIN, state({ watching: false })), "skip", "no session to watch");
  assert.equal(idleStep(5 * MIN, state({ busy: true })), "skip", "a turn finds out for itself");
  assert.equal(idleStep(IDLE_QUIET_MS, state()), "skip", "nobody there to read a banner");
  assert.equal(idleStep(IDLE_PARK_MS - 1, state()), "skip");
  assert.equal(idleStep(IDLE_PARK_MS, state()), "park");
  assert.equal(idleStep(IDLE_PARK_MS, state({ watching: false })), "park", "a browser with no session in it too");
  assert.equal(idleStep(IDLE_PARK_MS * 4, state({ parked: true })), "skip", "closed once, not every tick");
  assert.equal(idleStep(IDLE_PARK_MS, state({ busy: true })), "skip", "never under a turn");
  assert.ok(IDLE_QUIET_MS <= 30 * MIN, "quiet within half an hour");
  assert.ok(IDLE_PARK_MS >= 90 * MIN, "a lunch break keeps the live thread");
});

test("coming back looks at the session only when there is something to learn", { skip: needsBuild }, () => {
  const { lookOnWake, SESSION_WATCH_MS } = require(IDLE);
  assert.equal(lookOnWake(10_000, state()), false, "a window switch right after a check asks nothing");
  assert.equal(lookOnWake(SESSION_WATCH_MS, state()), true, "after a quiet spell it looks at once");
  assert.equal(lookOnWake(10_000, state({ parked: true })), true, "a parked browser is reopened straight away");
  assert.equal(lookOnWake(SESSION_WATCH_MS * 10, state({ watching: false })), false);
  assert.equal(lookOnWake(SESSION_WATCH_MS * 10, state({ busy: true })), false);
});

let checks = 0;
let closes = [];
let closeDelay = 0;

function makeEngine(sendImpl = async () => ({ content: DONE, conversationId: null })) {
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  providers.closeBrowser = async () => {
    closes.push("start");
    await sleep(closeDelay);
    closes.push("end");
  };
  providers.checkSignedIn = async () => {
    checks++;
    return { signedIn: true, reachable: true, detail: "" };
  };
  const { Engine } = require(DIST);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const peer = { emit() {}, request: async () => ({ allow: true }) };
  const engine = new Engine(peer, work);
  engine.transport = engine.wrapTransport({ name: "api", send: sendImpl, reset() {} });
  engine.connected = true;
  engine.auth = { cookies: [] };
  engine.history = [];
  engine.archived = [];
  engine.policy = { mode: "yolo", allowedCommands: new Set(), allowedWriteDirs: new Set(), bashRules: {} };
  engine.context = { instructionSources: [], environment: "", instructions: "", skills: [], cwd: work };
  return engine;
}

const reset = () => {
  checks = 0;
  closes = [];
  closeDelay = 0;
};

const waitIdle = async (engine) => {
  do await sleep(50);
  while (engine.busy);
};

test("twenty minutes unused, and the watch stops asking the service", { skip: needsBuild }, async () => {
  reset();
  const engine = makeEngine();
  engine.watching = true;
  engine.lastActiveAt = Date.now() - 5 * MIN;
  await engine.idleTick();
  assert.equal(checks, 1, "in use: checked");
  engine.lastActiveAt = Date.now() - 25 * MIN;
  await engine.idleTick();
  await engine.idleTick();
  assert.equal(checks, 1, "quiet: not asked again");
  assert.deepEqual(closes, [], "and nothing closed yet");
});

test("two hours unused, the browser is closed once, and the window coming back reopens it", { skip: needsBuild }, async () => {
  reset();
  const engine = makeEngine();
  engine.watching = true;
  engine.lastActiveAt = Date.now() - 125 * MIN;
  engine.lastCheckAt = Date.now() - 125 * MIN;
  await engine.idleTick();
  assert.deepEqual(closes, ["start", "end"]);
  await engine.idleTick();
  assert.deepEqual(closes, ["start", "end"], "parked once, not on every tick");
  assert.equal(checks, 0, "and asked nothing while parked");

  engine.wake();
  await sleep(20);
  assert.equal(checks, 1, "focus looks at once, which reopens the browser before anything is typed");
  assert.equal(engine.parked, false);
  engine.wake();
  await sleep(20);
  assert.equal(checks, 1, "a second focus a moment later asks nothing");
  assert.ok(Date.now() - engine.lastActiveAt < 5_000, "and coming back counts as use");
});

test("a message sent while the browser is closing waits for the close", { skip: needsBuild }, async () => {
  reset();
  closeDelay = 150;
  let seen = null;
  const engine = makeEngine(async () => {
    seen = [...closes];
    return { content: DONE, conversationId: null };
  });
  engine.lastActiveAt = Date.now() - 125 * MIN;
  const parking = engine.idleTick();
  await sleep(10);
  assert.deepEqual(closes, ["start"], "the close is under way");
  engine.send("hello");
  await waitIdle(engine);
  await parking;
  assert.deepEqual(seen, ["start", "end"], "the send went out after the close, not into a closing browser");
  assert.equal(engine.parked, false, "and the turn reopened it");
});

test("a turn counts as use, from when it ends", { skip: needsBuild }, async () => {
  reset();
  const engine = makeEngine(async () => {
    await sleep(60);
    return { content: DONE, conversationId: null };
  });
  engine.lastActiveAt = Date.now() - 125 * MIN;
  const started = Date.now();
  engine.send("do the thing");
  await waitIdle(engine);
  assert.ok(engine.lastActiveAt >= started + 50, "stamped when the work finished");
  await engine.idleTick();
  assert.deepEqual(closes, [], "so nothing is parked straight after it");
});

test("ChatGPT's browser is never parked", { skip: needsBuild }, () => {
  // Its live thread is the expensive thing to lose, and it has no session
  // watch to go quiet: the clock does not run for it at all.
  const engine = makeEngine();
  process.env.ONFLIP_PROVIDER = "chatgpt";
  try {
    engine.startIdleClock();
    assert.equal(engine.sessionWatch, null);
  } finally {
    process.env.ONFLIP_PROVIDER = "deepseek";
  }
  engine.startIdleClock();
  assert.notEqual(engine.sessionWatch, null, "while DeepSeek's does");
  engine.stopSessionWatch();
  assert.equal(engine.sessionWatch, null);
});
