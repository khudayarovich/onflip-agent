"use strict";

/**
 * A follow-up goes straight to the work, the way an IDE agent's does.
 *
 * Reported: "when I ask some update after a task finished, it learns the
 * whole code again, and takes a lot of time for a small edit." The saved
 * sessions on the reporting machine showed exactly that, and why:
 *
 *  - Compaction fired every 60 messages whatever the character budget said —
 *    six of seven compactions in one session landed at 60–61 messages — and
 *    each one replaced everything the model had read with a paragraph that
 *    ended "read every file again".
 *  - An edit answered only "Applied 1 replacement", so the model read the
 *    file again to see what it had done; the follow-up "video modal is not
 *    opening" made 58 tool calls, 21 of them reads, and read one 600-line
 *    file in full five times.
 *  - Each of those whole-file reads was 15–22k characters against a 40k
 *    budget, which is what forced the next compaction.
 *  - Nothing told the model where it had been working, so a follow-up opened
 *    with a survey of the project.
 *
 * These tests drive the real tools on real files, and the real loop through a
 * scripted transport, because each fix is a claim about what the model is
 * sent — and the only way to check that is to look at what was sent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The loop reads and clears the send cooldown in the config; keep it off
// the real ~/.onflip.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-followup-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");

const { changedRanges, excerpt, splitLines } = require("../dist/agent/lines");
const { recentWorkingSet, workingSetHint } = require("../dist/agent/working-set");
const {
  runTurn,
  syncFullReads,
  compactionReason,
  COMPACT_AFTER_MESSAGES_BACKSTOP,
} = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");

const numbered = (n, prefix = "line") =>
  `${Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n")}\n`;

function project(files) {
  const dir = fs.mkdtempSync(path.join(HOME, "proj-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const registryFor = (cwd, session) =>
  createToolRegistry({
    cwd,
    session,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });

/** A reply block the way the model writes one. */
function block(tool, args = {}) {
  const lines = ["```onflip", `tool: ${tool}`];
  for (const [key, value] of Object.entries(args)) {
    const text = String(value);
    if (text.includes("\n")) {
      lines.push(`${key}: |`, ...text.split("\n").map((l) => `  ${l}`));
    } else {
      lines.push(`${key}: ${text}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

function done(summary) {
  return ["````onflip", "tool: done", "summary: |", ...summary.split("\n").map((l) => `  ${l}`), "````"].join("\n");
}

/** A transport that answers from a script and remembers what it was sent. */
function scripted(replies) {
  const sent = [];
  return {
    sent,
    transport: {
      name: "api",
      async send(history, opts) {
        sent.push({ last: history[history.length - 1], history: history.slice(), reminder: opts.reminder });
        if (replies.length === 0) throw new Error("the script ran out of replies");
        const next = replies.shift();
        return { content: typeof next === "function" ? next(history) : next, conversationId: null };
      },
      reset() {},
    },
  };
}

function turn(cwd, session, transport, history, extra = {}) {
  return runTurn(history, {
    transport,
    tools: registryFor(cwd, session),
    session,
    model: "test-model",
    maxIterations: 12,
    shellEnabled: false,
    signal: new AbortController().signal,
    cwd,
    compactAfterChars: 100_000,
    ...extra,
  });
}

const said = (role, content, extra = {}) => ({
  id: `${role}-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  ...extra,
});

// --- where two versions differ ----------------------------------------------

test("changed lines are numbered as the file reads now", () => {
  const before = numbered(10);
  const after = before.replace("line 2\n", "line 2\ninserted a\ninserted b\n").replace("line 9\n", "line nine\n");
  // The insertion pushes line 9 down two places; the range must follow it.
  assert.deepEqual(changedRanges(before, after), [
    { start: 3, end: 4 },
    { start: 11, end: 11 },
  ]);
});

test("a deletion is shown as the two lines that now meet", () => {
  const before = numbered(10);
  const after = before.replace("line 5\nline 6\n", "");
  assert.deepEqual(changedRanges(before, after), [{ start: 4, end: 5 }]);
});

test("line endings alone are not a change", () => {
  assert.deepEqual(changedRanges("a\nb\n", "a\r\nb\r\n"), []);
});

test("an excerpt stops at a whole line and says where to resume", () => {
  const lines = splitLines(numbered(500));
  const shown = excerpt(lines, [{ start: 100, end: 400 }], { context: 0, maxLines: 20 });
  assert.equal(shown.lineCount, 20);
  assert.equal(shown.truncated, true);
  assert.equal(shown.resumeAt, 120);
  assert.match(shown.text, /^100│ line 100$/m);
});

// --- what an edit answers ---------------------------------------------------

test("an edit's result shows the changed lines as they now read", async () => {
  const cwd = project({ "app.js": numbered(60) });
  const session = createSessionState();
  const result = await registryFor(cwd, session).run("edit", {
    path: "app.js",
    old_string: "line 30\n",
    new_string: "line thirty\n",
  });
  assert.ok(!result.error, result.output);
  const [first] = result.output.split("\n");
  assert.equal(first, "Applied 1 replacement in app.js", "the first line stays what the log keys on");
  assert.match(result.output, /^30│ line thirty$/m);
  assert.match(result.output, /^27│ line 27$/m, "with a little context");
  assert.doesNotMatch(result.output, /│ line 10$/m, "and not the whole file");
  // Under the trimming threshold, so the snippet survives as long as the result.
  assert.ok(result.output.length < 2_000, `${result.output.length} characters`);
});

test("several places in one call are each shown, at their new numbers", async () => {
  const cwd = project({ "app.js": numbered(60) });
  const session = createSessionState();
  const result = await registryFor(cwd, session).run("multi_edit", {
    path: "app.js",
    edits: [
      { old_string: "line 5\n", new_string: "line 5\nline 5b\n" },
      { old_string: "line 50\n", new_string: "line fifty\n" },
    ],
  });
  assert.ok(!result.error, result.output);
  assert.match(result.output, /^\s*6│ line 5b$/m);
  assert.match(result.output, /^51│ line fifty$/m, "line 50 moved down one");
});

// --- a second read of the same file -----------------------------------------

test("reading a whole file again sends only what changed since", async () => {
  const cwd = project({ "app.js": numbered(200) });
  const file = path.join(cwd, "app.js");
  const session = createSessionState();
  const tools = registryFor(cwd, session);

  const first = await tools.run("read", { path: "app.js" });
  assert.equal(first.fullRead, file, "a whole-file read says so");
  assert.match(first.output, /^200│ line 200$/m);
  // What the loop does once the result is in the history.
  session.fullReads.get(file).messageId = "the-read";

  const again = await tools.run("read", { path: "app.js" });
  assert.match(again.output, /unchanged since you read the whole file/);
  assert.ok(again.output.length < 400, `${again.output.length} characters for an unchanged file`);

  await tools.run("edit", { path: "app.js", old_string: "line 120\n", new_string: "line one-twenty\n" });
  const changed = await tools.run("read", { path: "app.js" });
  assert.match(changed.output, /has changed since you read the whole file/);
  assert.match(changed.output, /^120│ line one-twenty$/m);
  assert.doesNotMatch(changed.output, /^\s*10│/m, "unchanged lines are not sent again");
  assert.ok(changed.output.length < first.output.length / 5);

  const explicit = await tools.run("read", { path: "app.js", offset: 1, limit: 5 });
  assert.match(explicit.output, /^1│ line 1$/m, "an explicit range always gets the lines themselves");
});

test("a read that is not in front of the model is sent whole", async () => {
  const cwd = project({ "app.js": numbered(80) });
  const session = createSessionState();
  const tools = registryFor(cwd, session);
  await tools.run("read", { path: "app.js" });
  // Never filed against a message — an interrupted step, say.
  const again = await tools.run("read", { path: "app.js" });
  assert.match(again.output, /^80│ line 80$/m);
});

test("a file mostly rewritten since is sent whole", async () => {
  const cwd = project({ "app.js": numbered(40) });
  const file = path.join(cwd, "app.js");
  const session = createSessionState();
  const tools = registryFor(cwd, session);
  await tools.run("read", { path: "app.js" });
  session.fullReads.get(file).messageId = "the-read";
  fs.writeFileSync(file, numbered(40, "other"));
  const again = await tools.run("read", { path: "app.js" });
  assert.match(again.output, /^ 1│ other 1$/m);
  assert.doesNotMatch(again.output, /changed since/);
});

test("reads the model cannot see any more are forgotten", () => {
  const read = said("user", "<onflip:result tool=\"read\">…</onflip:result>", { toolName: "read" });
  const pruned = said("user", "…cut…", { toolName: "read", prunedChars: 9_000 });
  const far = said("user", "x".repeat(10), { toolName: "read" });
  const history = [said("system", "prompt"), far, said("user", "y".repeat(5_000)), pruned, read, said("assistant", "ok")];
  const session = createSessionState();
  session.fullReads.set("visible", { content: "a", messageId: read.id });
  session.fullReads.set("gone", { content: "a", messageId: "not-in-history" });
  session.fullReads.set("trimmed", { content: "a", messageId: pruned.id });
  session.fullReads.set("far", { content: "a", messageId: far.id });
  session.fullReads.set("pending", { content: "a" });

  // `far` has 5,000 + a 9,000-character trimmed result after it: counted at
  // the size the live conversation holds, it is past a 10,000 budget.
  syncFullReads(session, history, 10_000);
  assert.deepEqual([...session.fullReads.keys()], ["visible"]);
});

// --- the loop ----------------------------------------------------------------

test("done beside edits that all applied ends the turn in one round trip", async () => {
  const cwd = project({ "app.js": numbered(20) });
  const session = createSessionState();
  const { sent, transport } = scripted([
    [block("edit", { path: "app.js", old_string: "line 7\n", new_string: "line seven\n" }), done("Renamed line 7.")].join("\n\n"),
  ]);
  const history = [said("system", "prompt"), said("user", "rename line 7")];
  const result = await turn(cwd, session, transport, history);

  assert.equal(result.endedBy, "done");
  assert.equal(sent.length, 1, "no second send just to repeat the done");
  assert.equal(result.finalAnswer, "Renamed line 7.");
  assert.match(fs.readFileSync(path.join(cwd, "app.js"), "utf8"), /line seven/);
  const last = history[history.length - 1];
  assert.equal(last.toolName, "edit", "the results are kept for the next turn to send");
  assert.doesNotMatch(last.content, /was ignored/);
});

test("done beside a read still waits for the model to see the result", async () => {
  const cwd = project({ "app.js": numbered(20) });
  const session = createSessionState();
  const { sent, transport } = scripted([
    [block("read", { path: "app.js" }), done("It says hello.")].join("\n\n"),
    done("Line 3 reads `line 3`."),
  ]);
  const result = await turn(cwd, session, transport, [said("system", "prompt"), said("user", "what is on line 3")]);
  assert.equal(sent.length, 2);
  assert.equal(result.finalAnswer, "Line 3 reads `line 3`.");
  assert.match(sent[1].last.content, /The done block in that reply was ignored/);
});

test("done beside an edit that failed is not the end", async () => {
  const cwd = project({ "app.js": numbered(20) });
  const session = createSessionState();
  const { sent, transport } = scripted([
    [block("edit", { path: "app.js", old_string: "no such text\n", new_string: "x\n" }), done("Done.")].join("\n\n"),
    done("Could not find it."),
  ]);
  const result = await turn(cwd, session, transport, [said("system", "prompt"), said("user", "change it")]);
  assert.equal(sent.length, 2);
  assert.equal(result.finalAnswer, "Could not find it.");
});

test("done beside edits with the task list still open is not the end", async () => {
  const cwd = project({ "app.js": numbered(20) });
  const session = createSessionState();
  session.todos = [{ id: "1", content: "the other half", status: "pending" }];
  const { sent, transport } = scripted([
    [block("edit", { path: "app.js", old_string: "line 7\n", new_string: "line seven\n" }), done("Done.")].join("\n\n"),
    done("Done, one item left."),
    done("Done, one item left."),
  ]);
  await turn(cwd, session, transport, [said("system", "prompt"), said("user", "change it")]);
  assert.ok(sent.length >= 2);
});

test("a whole-file read is filed against its message, so the next one is a delta", async () => {
  const cwd = project({ "app.js": numbered(300) });
  const session = createSessionState();
  const { sent, transport } = scripted([
    block("read", { path: "app.js" }),
    block("edit", { path: "app.js", old_string: "line 150\n", new_string: "line one-fifty\n" }),
    block("read", { path: "app.js" }),
    done("Changed line 150."),
  ]);
  await turn(cwd, session, transport, [said("system", "prompt"), said("user", "change line 150")]);
  const secondRead = sent[3].last.content;
  assert.match(secondRead, /has changed since you read the whole file/);
  assert.match(secondRead, /^150│ line one-fifty$/m);
  assert.ok(secondRead.length < 1_000, `${secondRead.length} characters`);
});

test("the first send of a follow-up names where the session was working", async () => {
  const cwd = project({ "src/app.js": numbered(90), "src/other.js": numbered(5) });
  const session = createSessionState();
  // The earlier task, through the real tool so the snapshot is real.
  await registryFor(cwd, session).run("edit", {
    path: "src/app.js",
    old_string: "line 42\n",
    new_string: "line forty-two\n",
  });

  const { sent, transport } = scripted([done("ok")]);
  await turn(cwd, session, transport, [said("system", "prompt"), said("user", "make it blue")]);
  assert.match(sent[0].reminder, /Where this session has been working/);
  assert.match(sent[0].reminder, /src\/app\.js \(90 lines\) at 42/);
  assert.doesNotMatch(sent[0].reminder, /other\.js/, "only files the session changed");
});

test("a session that has changed nothing is told nothing about it", async () => {
  const cwd = project({ "app.js": numbered(5) });
  const { sent, transport } = scripted([done("ok")]);
  await turn(cwd, createSessionState(), transport, [said("system", "prompt"), said("user", "hi")]);
  assert.doesNotMatch(sent[0].reminder, /Where this session has been working/);
});

test("after compaction the lines being worked on come back, not an order to re-read", async () => {
  const cwd = project({ "app.js": numbered(120) });
  const session = createSessionState();
  await registryFor(cwd, session).run("edit", {
    path: "app.js",
    old_string: "line 77\n",
    new_string: "line seventy-seven\n",
  });

  const { transport } = scripted([
    "Handover: renamed line 77 in app.js; the user wants it styled next.",
    done("ok"),
  ]);
  const history = [
    said("system", "prompt"),
    said("user", "rename line 77"),
    said("assistant", "z".repeat(4_000)),
    said("user", "now style it"),
  ];
  await turn(cwd, session, transport, history, { compactAfterChars: 3_000 });

  const brief = history.find((m) => /^\[Context carried over/.test(m.content));
  assert.ok(brief, "the session compacted");
  assert.match(brief.content, /Where you were working/);
  assert.match(brief.content, /^77│ line seventy-seven$/m);
  assert.doesNotMatch(brief.content, /Before editing any file, read it again/);
  assert.match(brief.content, /read just the part you need/);
});

// --- the message cap ----------------------------------------------------------

test("sixty short messages are not a reason to compact any more", () => {
  const history = [said("system", "prompt")];
  for (let i = 0; i < 70; i++) history.push(said(i % 2 ? "assistant" : "user", "short"));
  const limits = { compactAfterChars: 150_000, compactAfterMessages: COMPACT_AFTER_MESSAGES_BACKSTOP };
  assert.equal(compactionReason(history, limits), null);
  for (let i = 0; i < 200; i++) history.push(said("user", "short"));
  assert.match(compactionReason(history, limits), /messages/, "a runaway still stops");
  assert.equal(COMPACT_AFTER_MESSAGES_BACKSTOP, 240);
});

// --- the working set itself -----------------------------------------------------

test("the working set follows later edits and forgets reverted ones", async () => {
  const cwd = project({ "a.js": numbered(40), "b.js": numbered(10) });
  const session = createSessionState();
  const tools = registryFor(cwd, session);
  await tools.run("edit", { path: "a.js", old_string: "line 30\n", new_string: "line thirty\n" });
  // Two lines in at the top push the earlier change down.
  await tools.run("edit", { path: "a.js", old_string: "line 1\n", new_string: "head a\nhead b\nline 1\n" });
  // Changed and changed back: nothing of the session's left in it.
  await tools.run("edit", { path: "b.js", old_string: "line 3\n", new_string: "line three\n" });
  await tools.run("edit", { path: "b.js", old_string: "line three\n", new_string: "line 3\n" });
  await tools.run("write", { path: "c.js", content: "made here\n" });

  const set = recentWorkingSet(session.snapshots);
  const names = set.map((f) => path.basename(f.path));
  assert.deepEqual(names, ["c.js", "a.js"], "newest first, reverted file gone");
  const a = set.find((f) => f.path.endsWith("a.js"));
  assert.ok(a.ranges.some((r) => r.start <= 32 && r.end >= 32), JSON.stringify(a.ranges));
  assert.equal(set[0].created, true);

  const hint = workingSetHint(set, cwd);
  assert.match(hint, /c\.js \(new, 1 lines\)/);
  assert.match(hint, /a\.js \(42 lines\) at/);
});
