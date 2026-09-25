"use strict";

/**
 * The plan and the model list follow the account that is signed in.
 *
 * Found on this project's own machine: a Free account was signed in through
 * the window over an expired Pro Lite session, and OnFlip went on working
 * from Pro Lite's plan and model list all afternoon. Both were only ever read
 * at start-up — where the list read failed on the expired session ("token
 * expired") and the plan read came back empty, as the session document does
 * straight after a launch — and nothing read them again after the sign-in.
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-plan-fix-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const DONE = "```onflip\ntool: done\nsummary: |\n  finished\n```";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

/** The Pro Lite account's leftovers, as the machine's config held them. */
const PRO_LITE_LEFTOVERS = {
  planType: "prolite",
  model: "gpt-5-6-mini",
  modelPinned: true,
  thinking: "low",
  discoveredModels: [
    { slug: "gpt-5-6-mini", title: "GPT-5.6 Luna", description: "" },
    { slug: "gpt-5-6-t-mini", title: "GPT-5.6 Luna", description: "" },
  ],
};

function makeEngine(extra = {}) {
  const config = require(path.join(ROOT, "dist", "config.js"));
  config.saveConfig({ ...PRO_LITE_LEFTOVERS, ...extra });
  const providers = require(path.join(ROOT, "dist", "providers", "index.js"));
  providers.closeBrowser = async () => {};
  const { Engine } = require(DIST);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const events = [];
  const peer = {
    emit(event, data) {
      events.push({ event, data });
    },
    request: async () => ({ allow: true }),
  };
  const engine = new Engine(peer, work);
  const counts = { resets: 0, refreshes: 0 };
  engine.transport = {
    name: "browser",
    send: async () => ({ content: DONE, conversationId: null }),
    reset() {
      counts.resets++;
    },
  };
  engine.refreshModels = async () => {
    counts.refreshes++;
    return [];
  };
  engine.auth = { cookies: [], sessionToken: "", accessToken: "" };
  engine.connected = true;
  engine.history = [];
  engine.archived = [];
  engine.context = { instructionSources: [], environment: "", instructions: "", skills: [], cwd: work };
  engine.seedSystemPrompt();
  const notices = () =>
    events.filter((e) => e.event === "item" && e.data?.type === "notice").map((e) => String(e.data.text));
  return { engine, config, providers, counts, notices };
}

test("the plan a turn's end reads is taken: Free limits in, the metered model out", { skip: needsBuild, timeout: 20_000 }, async () => {
  const { engine, config, providers, counts, notices } = makeEngine();
  const { effectiveModel } = require(path.join(ROOT, "dist", "models.js"));
  // What the stale plan did: "low" thinking on a plan it took for Pro Lite
  // opens the metered Thinking variant, and the prompt has no reply limit.
  assert.equal(effectiveModel(engine.model, engine.thinking), "gpt-5-6-t-mini");
  assert.doesNotMatch(engine.history[0].content, /Keep every reply under about/);

  providers.pageSessionUser = async () => ({ name: "Nodira", email: "nodira@example.com", planType: "free" });
  engine.maybeIdentifyAccount();
  assert.ok(await until(() => config.loadConfig().planType === "free" && counts.resets > 0), "the plan was never taken");

  assert.match(engine.history[0].content, /Keep every reply under about 10,000 characters/);
  assert.equal(effectiveModel(engine.model, engine.thinking), "gpt-5-6-mini");
  // The live chat was opened on the metered model; the next message opens a fresh one.
  assert.equal(counts.resets, 1);
  assert.equal(counts.refreshes, 1, "the model list is the plan's, and is read again");
  assert.ok(notices().some((n) => /Free/.test(n) && /Pro Lite/.test(n)), notices().join(" | "));
  assert.equal(engine.account.email, "nodira@example.com");
  assert.equal("planType" in engine.account, false);
});

test("a sign-in reads the plan and the model list again, and the next message waits for it", { skip: needsBuild, timeout: 20_000 }, async () => {
  // A complete list, with each model's window, and a plan the new account
  // shares: nothing else about the stored state asks for a re-read, so the
  // sign-in has to.
  const { engine, config, providers, counts } = makeEngine({
    discoveredModels: PRO_LITE_LEFTOVERS.discoveredModels.map((m) => ({ ...m, maxTokens: 196_608 })),
  });
  // Verified earlier in the run, for the account that was signed in then.
  engine.accountVerified = true;
  let planReads = 0;
  providers.fetchAccountPlan = async () => {
    planReads++;
    await sleep(200);
    return "prolite";
  };
  providers.pageSessionUser = async () => null;

  await engine.applySignIn(
    [{ name: "__Secure-next-auth.session-token", value: "x".repeat(40) }],
    { name: "Nodira", email: "nodira@example.com" }
  );
  // The first send waits on exactly this.
  assert.ok(engine.warming, "nothing for the next message to wait on");
  await engine.warming;
  assert.equal(planReads, 1);
  assert.equal(config.loadConfig().planType, "prolite");
  // Read again although a list was stored: it was the other account's.
  assert.equal(counts.refreshes, 1);
  // And the account is asked about again after the next turn.
  assert.equal(engine.accountVerified, false);
});

test("a sign-in through the window reads them again too — the way this machine's Free account came in", { skip: needsBuild, timeout: 20_000 }, async () => {
  const { engine, config, providers, counts } = makeEngine();
  let planReads = 0;
  providers.fetchAccountPlan = async () => {
    planReads++;
    return "free";
  };
  providers.pageSessionUser = async () => null;
  providers.signInWithRealBrowser = async () => ({ ok: true, browser: { name: "Chrome", channel: "chrome" } });
  const result = await engine.signInWithBrowser();
  assert.equal(result.ok, true);
  assert.ok(engine.warming, "nothing for the next message to wait on");
  await engine.warming;
  assert.equal(planReads, 1);
  assert.equal(config.loadConfig().planType, "free");
  assert.equal(counts.refreshes, 1);
});
