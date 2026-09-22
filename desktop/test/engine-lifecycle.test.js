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
  assert.equal(path.resolve(ranIn), path.resolve(work), `ran in ${ranIn}`);
});
