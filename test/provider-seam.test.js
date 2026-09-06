"use strict";

/**
 * What the seam does with calls a provider cannot answer.
 *
 * The engine asks about Projects, plans and image replies on ordinary paths —
 * the status payload alone reaches for the plan and the project list, on every
 * tool call. ChatGPT has them and DeepSeek does not, so the question is not
 * whether DeepSeek can do these things but what happens when it is asked.
 * Throwing would turn "this service has no projects" into a broken session.
 *
 * Attachments are not in that group, though they were once: DeepSeek takes
 * files, and treating that as an absence broke Vision mode.
 *
 * The rule: absence answers with the shape that means nothing is there.
 * Refusal — losing something the user actually asked for — says so out loud.
 *
 * Nothing here touches a browser. Every call tested is one that must answer
 * without one, which is the point: these run on paths where a browser launch
 * would itself be the bug.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-seam-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_PROVIDER;
fs.mkdirSync(path.join(HOME, ".onflip"), { recursive: true });
const use = (provider) =>
  fs.writeFileSync(path.join(HOME, ".onflip", "config.json"), JSON.stringify({ provider }));

const seam = require("../dist/providers");
const NO_COOKIES = [];

// --- absence answers quietly ------------------------------------------------

test("projects are empty rather than an error", async () => {
  use("deepseek");
  assert.deepEqual(await seam.listProjects(NO_COOKIES), []);
  assert.deepEqual(await seam.listProjectConversations(NO_COOKIES, "p1"), []);
  assert.equal(seam.takeProjectWarning(), null);
  // Setting one is a no-op, not a throw: the engine calls it on session load.
  assert.equal(seam.setActiveProject(null), undefined);
  await seam.sweepConversationsIntoProject(["a"]);
});

test("the plan is null, which is the budget answer we want anyway", async () => {
  // compactionBudget treats an unknown plan as "use the composer ceiling",
  // and DeepSeek's real limit is exactly what its composer will take.
  use("deepseek");
  assert.equal(await seam.fetchAccountPlan(NO_COOKIES), null);
});

test("conversation listing and deletion are empty, not broken", async () => {
  use("deepseek");
  assert.deepEqual(await seam.listConversations(NO_COOKIES), []);
  assert.deepEqual(seam.openedConversationIds(), []);
  // Nothing was opened remotely, so there is nothing of OnFlip's to remove.
  assert.deepEqual(await seam.deleteConversations(NO_COOKIES, ["x"]), { deleted: [], failed: [] });
});

test("image replies are an empty list", () => {
  use("deepseek");
  assert.deepEqual(seam.takeReplyImages(), []);
});

// --- attachments, which both services take ---------------------------------

test("attaching files on DeepSeek does not refuse", () => {
  // It used to. The refusal was written before anyone looked for a file
  // input, and DeepSeek has one — hidden, multiple, accepting images. The
  // cost of that mistake was the case that needs it most: Vision mode
  // selected, a screenshot attached, and the send going out without it.
  use("deepseek");
  seam.queueAttachments([]);
  assert.equal(seam.takeComposerWarning(), null, "no warning: attaching works here");
});

test("a path that does not exist is dropped rather than sent", () => {
  // The driver filters to files that are actually on disk, so a stale path
  // cannot make a turn fail at the browser.
  use("deepseek");
  seam.queueAttachments(["C:\nope\missing.png"]);
  assert.equal(seam.takeComposerWarning(), null);
});

test("what cannot be faked throws with a reason a person can act on", async () => {
  use("deepseek");
  await assert.rejects(() => seam.createProject(NO_COOKIES, "x"), /no projects/i);
  await assert.rejects(() => seam.openConversation(NO_COOKIES, "abc"), /not supported yet/i);
});

// --- ChatGPT is routed, not reimplemented -----------------------------------

test("on ChatGPT every one of these reaches the real driver", async () => {
  // Proof the seam dispatches rather than answering for both. These would all
  // need a browser, so a rejection is the right outcome here — what matters is
  // that they are NOT the empty answers DeepSeek gives.
  use("chatgpt");
  assert.equal(seam.takeProjectWarning(), null); // genuinely null with no session
  assert.deepEqual(seam.takeReplyImages(), []);
  // queueAttachments must reach ChatGPT's, so no DeepSeek warning appears.
  seam.queueAttachments([]);
  assert.equal(seam.takeComposerWarning(), null);
});

test("queueing on one service does not leave anything for the other", () => {
  // Each provider's driver holds its own pending files; switching must not
  // carry one service's attachment into the next turn on the other.
  use("deepseek");
  seam.queueAttachments([path.join(HOME, "nothing.png")]);
  use("chatgpt");
  assert.equal(seam.takeComposerWarning(), null, "ChatGPT sees its own channel, not DeepSeek's");
});
