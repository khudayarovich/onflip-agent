"use strict";

/**
 * The engine's own bookkeeping around a turn, driven for real: the built
 * Engine, a fake window and a scripted transport. Each case was reproduced
 * with this harness before it was fixed.
 *
 *  - Stop pressed during /compact armed the force stop, and nothing cleared
 *    it: five seconds into the next turn it closed the browser under that
 *    turn's send.
 *  - The silence watchdog "restarted" a wedged turn by aborting it — which a
 *    `page.evaluate` that never returns never sees — and queued "continue"
 *    behind it. The turn stayed wedged; nothing forced it.
 *  - The shell's directory is process-wide and only a change of project
 *    reset it, so after /new the first command ran in the previous
 *    session's subfolder.
 *  - A message that arrived while a switch waited on the browser started a
 *    turn anyway, on a page on its way to another conversation.
 *  - The watchdog queued its "continue" behind what the person had queued.
 *  - A session open in another window could be deleted from under it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(__dirname, "..", "dist", "engine", "engine.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-engine-life-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const DONE = "```onflip\ntool: done\nsummary: |\n  finished\n```";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replies after `ms`, or rejects the moment the turn is aborted. */
function abortable(signal, ms, value) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(value), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let closed = [];
function makeEngine(sendImpl) {
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  providers.closeBrowser = async () => {
    closed.push(Date.now());
  };
  const { Engine } = require(DIST);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  fs.mkdirSync(path.join(work, "sub"));
  const events = [];
  const peer = {
    emit(event, data) {
      events.push({ event, data });
    },
    request: async () => ({ allow: true }),
  };
  const engine = new Engine(peer, work);
  engine.transport = { name: "api", send: sendImpl, reset() {} };
  engine.connected = true;
  engine.history = [];
  engine.archived = [];
  engine.policy = { mode: "yolo", allowedCommands: new Set(), allowedWriteDirs: new Set(), bashRules: {} };
  engine.context = { instructionSources: [], environment: "", instructions: "", skills: [], cwd: work };
  return { engine, events, work };
}

const waitIdle = async (engine) => {
  do await sleep(100);
  while (engine.busy);
};

test("Undo acts on the change its dialog named, or not at all", { skip: needsBuild }, () => {
  // The confirmation is built from one change and Undo used to land on
  // whatever was last at the click: a turn that wrote a report while the
  // dialog asked about styles.css had the report deleted instead.
  const { engine, work } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  const { captureFileRevision } = require(path.join(ROOT, "dist", "tools", "revision.js"));
  const write = (file, after) => {
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    fs.writeFileSync(file, after, "utf8");
    const { contents: _c, ...afterRevision } = captureFileRevision(file);
    engine.toolState.snapshots.push({ path: file, before, after, afterRevision, tool: "write", at: Date.now() });
  };
  const styles = path.join(work, "styles.css");
  const report = path.join(work, "report.md");
  fs.writeFileSync(styles, "body{}");
  write(styles, "body{color:red}");
  const preview = engine.undoPreview();
  assert.equal(preview.rel, "styles.css");

  write(report, "# the report the agent just wrote\n");
  const refused = engine.undoLast(preview.token);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /report\.md/);
  assert.equal(fs.existsSync(report), true, "the report was deleted");
  assert.equal(fs.readFileSync(styles, "utf8"), "body{color:red}");

  const again = engine.undoPreview();
  assert.equal(again.rel, "report.md");
  assert.equal(engine.undoLast(again.token).ok, true);
  assert.equal(fs.existsSync(report), false);
});

test("the engine's Undo steps back through one file's edits", { skip: needsBuild }, () => {
  const { engine, work } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  const { captureFileRevision } = require(path.join(ROOT, "dist", "tools", "revision.js"));
  const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  const file = path.join(work, "app.ts");
  fs.writeFileSync(file, "v0");
  for (const [before, after] of [["v0", "v1"], ["v1", "v2"]]) {
    fs.writeFileSync(file, after, "utf8");
    const { contents: _c, ...afterRevision } = captureFileRevision(file);
    engine.toolState.snapshots.push({ path: file, before, after, afterRevision, tool: "edit", at: Date.now() });
    tick();
  }
  assert.equal(engine.undoLast(engine.undoPreview().token).ok, true);
  tick();
  const second = engine.undoLast(engine.undoPreview().token);
  assert.equal(second.ok, true, second.message);
  assert.equal(fs.readFileSync(file, "utf8"), "v0");
});

test("rolling a message back returns its words and its files, without OnFlip's notes", { skip: needsBuild }, async () => {
  // Edit and Resend are built on this. The history kept only a note naming
  // the files, so a resend sent "[Attached to this message: …]" as words
  // and attached nothing.
  const { engine, work } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  const file = path.join(work, "shot.png");
  fs.writeFileSync(file, "png");
  // A real session, which opens with its system prompt.
  engine.newSession();
  engine.send("look at this", [file]);
  await waitIdle(engine);
  const sent = engine.history.find((m) => m.role === "user");
  assert.deepEqual(sent.attachments, [file]);
  const back = engine.rollbackMessage(sent.id);
  assert.deepEqual(back, { text: "look at this", attachments: [file] });
});

test("a sub-agent's output keeps the silence watchdog quiet", { skip: needsBuild, timeout: 60_000 }, async () => {
  // The watchdog heard only the sub-agent's step starts: a sub-agent running
  // a test suite drew "nothing has come back" at 150 seconds and was killed
  // and restarted at 420, up to three times.
  const configFile = path.join(process.env.ONFLIP_CONFIG_DIR, "config.json");
  const saved = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ ...(saved ? JSON.parse(saved) : {}), subAgents: true }));
  try {
    const ticks =
      process.platform === "win32"
        ? '1..8 | % { Write-Output "tick $_"; Start-Sleep -Milliseconds 400 }'
        : "for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.4; done";
    const stream = "```onflip\ntool: bash\ncommand: " + ticks + "\n```";
    const task = "```onflip\ntool: task\ndescription: run the suite\nprompt: |\n  Run the tests.\n```";
    const script = [task, stream, DONE];
    const { engine } = makeEngine(async () => ({ content: script.shift() ?? DONE, conversationId: null }));
    let inSub = false;
    let longest = 0;
    const emit = engine.peer.emit;
    engine.peer.emit = (event, data) => {
      if (event === "sub-tasks") inSub = data.subTasks.some((t) => t.status === "running");
      return emit(event, data);
    };
    const sampler = setInterval(() => {
      if (engine.busy && inSub) longest = Math.max(longest, engine.silence.idleMs());
    }, 50);
    engine.send("use a sub-task to run the tests");
    await waitIdle(engine);
    clearInterval(sampler);
    assert.ok(longest > 0, "the sub-agent never ran");
    assert.ok(longest < 2_000, `the watchdog saw ${longest}ms of silence while the sub-agent's command streamed`);
  } finally {
    if (saved === null) fs.rmSync(configFile, { force: true });
    else fs.writeFileSync(configFile, saved);
  }
});

test("a setting named after Object.prototype is not a setting", { skip: needsBuild }, () => {
  // The table of settings answered for "constructor" with the Object
  // function, which ran on the value and saved whatever it made.
  const { engine } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  const file = path.join(process.env.ONFLIP_CONFIG_DIR, "config.json");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
    assert.throws(() => engine.setConfigValue(key, "x"), /Unknown setting/, key);
  }
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null, before);
});

test("Stop during /compact does not close the browser under the next turn", { skip: needsBuild }, async () => {
  closed = [];
  let call = 0;
  const { engine } = makeEngine(async (history, opts) => {
    call++;
    if (call === 1) return { content: await abortable(opts.signal, 120_000, "summary"), conversationId: null };
    return { content: await abortable(opts.signal, 7_000, DONE), conversationId: null };
  });
  engine.history.push(
    { id: "u1", role: "user", content: "earlier question", createdAt: Date.now() },
    { id: "a1", role: "assistant", content: "earlier answer", createdAt: Date.now() }
  );
  const compacting = engine.compactTranscript().catch(() => {});
  await sleep(300);
  engine.interrupt();
  await compacting;
  engine.send("run the tests");
  await sleep(6_500);
  assert.equal(closed.length, 0, "the browser was closed under the new turn");
  engine.interrupt();
  await waitIdle(engine);
});

test("the watchdog's restart forces a wedged turn to end", { skip: needsBuild }, async () => {
  closed = [];
  // A send that never settles and ignores the abort: a blocked renderer.
  const { engine } = makeEngine(() => new Promise(() => {}));
  engine.send("build the project");
  await sleep(200);
  const real = engine.silence.now;
  engine.silence.now = () => real() + 430_000;
  engine.silence.tick();
  engine.silence.now = real;
  await sleep(6_500);
  assert.ok(closed.length >= 1, "nothing forced the wedged turn to end");
});

test("a new session's commands start at its own folder", { skip: needsBuild }, async () => {
  const bash = (cmd) => "```onflip\ntool: bash\ncommand: " + cmd + "\n```";
  const script = [bash("cd sub"), DONE, bash('node -e "console.log(process.cwd())"'), DONE];
  const { engine, events, work } = makeEngine(async () => ({ content: script.shift(), conversationId: null }));
  engine.send("go into sub");
  await waitIdle(engine);
  engine.newSession();
  engine.send("where are you?");
  await waitIdle(engine);
  const outputs = events.filter((e) => e.event === "tool-update").map((e) => e.data.result.output);
  const ranIn = outputs[outputs.length - 1].split("\n")[0].trim();
  // As the file system names them: a shell reports the long name behind an
  // 8.3 TEMP, and macOS's /var is /private/var.
  const real = (p) => fs.realpathSync.native(p);
  assert.equal(real(ranIn), real(work), `ran in ${ranIn}`);
});

test("a session open in another window is not deleted from under it", { skip: needsBuild }, () => {
  // Deleting it removed the file, which that window's next save put back,
  // and deleted the session's ChatGPT chats while that window was still
  // talking in them.
  const { engine, work } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  const store = require(path.join(ROOT, "dist", "agent", "store.js"));
  const { sessionLockFile } = require(path.join(__dirname, "..", "dist", "engine", "session-lock.js"));
  const held = store.createSession(work, "gpt");
  assert.equal(store.saveSession(held), true);
  // Held by a live process that is not this one: the test runner.
  fs.writeFileSync(sessionLockFile(held.id), JSON.stringify({ pid: process.ppid, at: Date.now(), token: "t" }));
  assert.throws(() => engine.removeSession(held.id), /open in another window/);
  assert.ok(store.loadSession(held.id), "the session is still there");

  // The false-positive half: a lock whose owner is gone is no one's, and a
  // session nobody holds is deleted as before.
  const orphan = store.createSession(work, "gpt");
  store.saveSession(orphan);
  fs.writeFileSync(sessionLockFile(orphan.id), JSON.stringify({ pid: 2 ** 22 + 12345, at: 0, token: "t" }));
  fs.utimesSync(sessionLockFile(orphan.id), new Date(0), new Date(0));
  assert.deepEqual(engine.removeSession(orphan.id), { ok: true });
  assert.equal(store.loadSession(orphan.id), null);
  const free = store.createSession(work, "gpt");
  store.saveSession(free);
  assert.deepEqual(engine.removeSession(free.id), { ok: true });
});

test("the watchdog's continue goes before what the person queued", { skip: needsBuild }, async () => {
  // Queued behind the person's own follow-up, the follow-up ran first and
  // the stuck work resumed after it, out of the order it was asked in.
  // Marked busy by hand rather than wedged for real: a wedged turn keeps its
  // silence watchdog running, and a process with a live timer never exits.
  const { engine } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  engine.busy = true;
  assert.deepEqual(engine.send("then add a test for it"), { queued: true });
  engine.restartSilentTurn(430_000);
  try {
    assert.deepEqual(
      engine.queue.map((q) => [q.text, Boolean(q.auto)]),
      [["continue", true], ["then add a test for it", false]]
    );
  } finally {
    engine.clearForceStop();
    engine.queue = [];
    engine.busy = false;
  }
});

test("a message that arrives while a chat is being attached waits for it", { skip: needsBuild, timeout: 20_000 }, async () => {
  // Attaching reads the chat before it swaps the session. A message from the
  // phone in that gap started a turn on the session being replaced, typing
  // into a page that was on its way to another conversation.
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  const realOpen = providers.openConversation;
  let release;
  providers.openConversation = () => new Promise((resolve) => (release = resolve));
  try {
    const sent = [];
    const { engine } = makeEngine(async (history) => {
      sent.push(history.map((m) => m.content));
      return { content: DONE, conversationId: null };
    });
    engine.auth = { cookies: [], accessToken: "" };
    engine.transport = { name: "browser", adopt() {}, send: engine.transport.send, reset() {} };
    // Attaching needs the browser transport; nothing in these turns may reach a
    // real browser, so the page-side bookkeeping a turn does is marked done.
    engine.projectEnsured = true;
    engine.accountVerified = true;
    const attaching = engine.attachChat("6f1e2d3c", "Holiday plans");
    await sleep(20);
    assert.deepEqual(engine.send("from the phone"), { queued: true }, "held, not run");
    assert.throws(() => engine.newSession(), /Still opening/, "and nothing else switches underneath");
    await sleep(100);
    assert.equal(sent.length, 0, "no turn ran during the switch");

    release([{ role: "user", content: "plan a trip" }, { role: "assistant", content: "Where to?" }]);
    await attaching;
    await waitIdle(engine);
    assert.equal(sent.length, 1, "the held message ran once the chat was attached");
    assert.ok(sent[0].includes("Where to?"), "on the attached chat, not the one it replaced");
    assert.ok(sent[0].some((c) => c.includes("from the phone")));
  } finally {
    providers.openConversation = realOpen;
  }
});

test("a switch that fails still hands on what it held", { skip: needsBuild, timeout: 20_000 }, async () => {
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  const realOpen = providers.openConversation;
  let fail;
  providers.openConversation = () => new Promise((_resolve, reject) => (fail = reject));
  try {
    const sent = [];
    const { engine } = makeEngine(async (history) => {
      sent.push(history.map((m) => m.content));
      return { content: DONE, conversationId: null };
    });
    engine.auth = { cookies: [], accessToken: "" };
    engine.transport = { name: "browser", adopt() {}, send: engine.transport.send, reset() {} };
    // Attaching needs the browser transport; nothing in these turns may reach a
    // real browser, so the page-side bookkeeping a turn does is marked done.
    engine.projectEnsured = true;
    engine.accountVerified = true;
    // The session the failed switch leaves open, as a real engine always has.
    engine.newSession();
    const attaching = engine.attachChat("6f1e2d3c");
    await sleep(20);
    engine.send("still here?");
    fail(new Error("That conversation could not be opened."));
    await assert.rejects(attaching, /could not be opened/);
    await waitIdle(engine);
    assert.equal(sent.length, 1, "the held message ran on the session that stayed open");
    // The false-positive half: with no switch running, a send is not held.
    assert.deepEqual(engine.send("and again"), { queued: false });
    await waitIdle(engine);
  } finally {
    providers.openConversation = realOpen;
  }
});

test("resuming, opening and signing in hold sends the same way", { skip: needsBuild }, () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "engine", "engine.ts"), "utf8");
  for (const [name, call] of [
    ["resumeSession(id: string)", "this.doResumeSession(id)"],
    ["openProject(dir: string)", "this.doOpenProject(dir)"],
    ["attachChat(id: string, title?: string)", "this.doAttachChat(id, title)"],
    ["signInWithBrowser()", "this.doSignInWithBrowser()"],
  ]) {
    const at = src.indexOf(`\n  ${name}: Promise<`);
    assert.ok(at >= 0, `${name} is still the public entry`);
    assert.ok(src.slice(at, at + 400).includes(`return this.holdingSends(() => ${call});`), `${name} holds sends`);
  }
});

test("a file left out for the shared budget is not blamed on its own size", { skip: needsBuild }, () => {
  const { engine, events } = makeEngine(async () => ({ content: DONE, conversationId: null }));
  engine.context = {
    ...engine.context,
    instructionsSkipped: [
      { file: "AGENTS.md", bytes: 20_000, reason: "total" },
      { file: "CLAUDE.md", bytes: 40_000, reason: "file" },
    ],
  };
  engine.reportSkippedInstructions();
  const said = events.filter((e) => e.event === "item" && e.data?.type === "notice").map((e) => e.data.text);
  assert.equal(said.length, 2);
  assert.match(said[0], /AGENTS\.md \(20KB\) was not loaded: with the instruction files nearer this folder/);
  assert.doesNotMatch(said[0], /over the 32KB limit for instruction files/);
  assert.match(said[1], /CLAUDE\.md is 40KB, over the 32KB limit for instruction files/);
});

// --- a throttle is a pause, not the end of the work ---------------------------

// A one-second throttle is what these tests can afford to wait out; the
// shipped floor is thirty seconds.
process.env.ONFLIP_MIN_THROTTLE_SECONDS = "1";

/** What ChatGPT's 429 looks like by the time it reaches the loop. */
function throttled(seconds) {
  const e = new Error(
    `ChatGPT is throttling this account (too many requests: status 429 on /backend-api/f/conversation, retry-after ${seconds}). Waiting before sending again; retrying now would extend the block.`
  );
  e.code = "throttled";
  return e;
}

const notices = (events) => events.filter((e) => e.event === "item" && e.data?.type === "notice").map((e) => e.data.text);

test("after a 429 the work carries on by itself once the cooldown has passed", { skip: needsBuild, timeout: 20_000 }, async () => {
  const { clearCooldown } = require(path.join(ROOT, "dist", "chatgpt", "backoff.js"));
  clearCooldown();
  const sent = [];
  const { engine, events } = makeEngine(async (history) => {
    sent.push(history[history.length - 1].content);
    if (sent.length === 1) throw throttled(1);
    return { content: DONE, conversationId: null };
  });
  engine.send("build the board");
  await waitIdle(engine);
  assert.equal(sent.length, 1, "nothing is sent into the throttle");
  assert.ok(notices(events).some((n) => /carry on by itself when the pause ends/.test(n)), notices(events).join("\n"));
  // The one-second cooldown, the margin after it, and the resumed turn.
  const deadline = Date.now() + 10_000;
  while (sent.length < 2 && Date.now() < deadline) await sleep(100);
  await waitIdle(engine);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /continue/);
  assert.ok(notices(events).some((n) => /pause is over/.test(n)));
  clearCooldown();
});

test("stop cancels the resume a cooldown is waiting to send", { skip: needsBuild, timeout: 20_000 }, async () => {
  const { clearCooldown } = require(path.join(ROOT, "dist", "chatgpt", "backoff.js"));
  clearCooldown();
  const sent = [];
  const { engine } = makeEngine(async (history) => {
    sent.push(history[history.length - 1].content);
    if (sent.length === 1) throw throttled(1);
    return { content: DONE, conversationId: null };
  });
  engine.send("build the board");
  await waitIdle(engine);
  engine.interrupt();
  await sleep(4_000);
  assert.equal(sent.length, 1, "nothing was resumed after stop");
  clearCooldown();
});

test("with temporary chats nothing is filed, so no project is listed or made", { skip: needsBuild, timeout: 20_000 }, async () => {
  // A fresh install listed the account's projects and created an "OnFlip"
  // one before its first message — two requests, and a project in the
  // user's account — for chats that never reach the account's history.
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  const real = { list: providers.listProjects, create: providers.createProject };
  const calls = [];
  providers.listProjects = async () => {
    calls.push("list");
    return [];
  };
  providers.createProject = async (_c, name) => {
    calls.push("create");
    return { id: "g-p-1", shortUrl: "g-p-1-onflip", name };
  };
  try {
    const { engine } = makeEngine(async () => ({ content: DONE, conversationId: null }));
    engine.transport.name = "browser";
    engine.auth = { cookies: [], accessToken: "", sessionToken: "" };
    // Who is signed in is asked of a real page after a browser turn; this
    // test has none to ask.
    engine.accountVerified = true;
    engine.send("hello");
    await waitIdle(engine);
    assert.deepEqual(calls, []);
  } finally {
    providers.listProjects = real.list;
    providers.createProject = real.create;
  }
});
