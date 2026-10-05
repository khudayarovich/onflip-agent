"use strict";

// Exercise the real browser send loops without opening an account or sending
// a request. An unarranged Playwright launch fails the test immediately.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-provider-reliability-"));
process.env.ONFLIP_CONFIG_DIR = path.join(temp, ".onflip");
process.env.HOME = temp;
process.env.USERPROFILE = temp;
let arranged;
const playwrightKey = require.resolve("playwright");
require.cache[playwrightKey] = {
  id: playwrightKey, filename: playwrightKey, loaded: true,
  exports: { chromium: { async launchPersistentContext() {
    assert.ok(arranged, "no real browser launch is allowed");
    const context = arranged;
    arranged = null;
    return context;
  } } },
};
const deepseek = require("../dist/providers/deepseek/browser");
const qwen = require("../dist/providers/qwen/browser");
const backoff = require("../dist/chatgpt/backoff");
const realNow = Date.now;
let now;

test.beforeEach(() => {
  now = realNow();
  Date.now = () => now;
});
test.afterEach(async () => {
  await deepseek.closeBrowser();
  await qwen.closeBrowser();
  backoff.__resetPacingForTest();
  Date.now = realNow;
  delete process.env.ONFLIP_REPLY_TIMEOUT;
});
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function fixture(provider, options = {}) {
  process.env.ONFLIP_PROVIDER = provider;
  backoff.__resetPacingForTest();
  const events = {};
  const state = { timeline: [], sends: 0, stops: 0, polls: 0, thinking: false, label: "Other model", pickerReady: !options.delayedPicker };
  const emitSend = () => {
    state.sends++;
    state.timeline.push("send");
    if (options.status) {
      const url = () => "https://chat.deepseek.com/api/v0/chat/completion";
      events.request?.({ url });
      events.response?.({ url, status: () => options.status,
        headers: () => ({ "retry-after": "120" }),
        text: () => options.hungBody ? new Promise(() => {}) : Promise.resolve("quota"),
      });
      events.requestfinished?.({ url });
    }
  };
  const root = provider === "deepseek" ? "https://chat.deepseek.com/" : "https://chat.qwen.ai/";
  const page = {
    at: root,
    url() { return this.at; },
    async goto(next) {
      state.timeline.push("navigate");
      this.at = next;
      state.label = "Other model";
      state.thinking = false;
    },
    async waitForTimeout(ms) { now += ms; },
    async waitForSelector(selector) {
      if (selector.includes("Select Model")) { state.pickerReady = true; state.timeline.push("picker-ready"); }
    },
    async waitForResponse() { return { status: () => 200 }; },
    async waitForFunction() {
      if (options.refuseLanding) throw new Error("the composer never emptied");
      return { async dispose() {} };
    },
    async $$eval(selector) {
      if (selector.startsWith("textarea")) return 1;
      if (selector.includes("Select Model")) return state.pickerReady ? 1 : 0;
      return state.sends ? 1 : 0;
    },
    async $eval(_selector, fn) {
      if (!state.pickerReady) throw new Error("the picker has not mounted yet");
      return fn({ innerText: state.label });
    },
    async click(selector) {
      if (selector.includes("Select Model") && !state.pickerReady) throw new Error("the picker has not mounted yet");
      if (selector.includes("role=\"option\"")) {
        state.timeline.push("model");
        if (!options.refuseModel) state.label = /has-text\("([^"]+)"\)/.exec(selector)[1];
      } else if (selector === "button.send-button") emitSend();
      else if (selector.includes("stop-button") || selector === ".ds-button--primary") {
        state.stops++;
      }
    },
    keyboard: { async press(key) { if (key === "Enter") { emitSend(); now += 2; } } },
    async evaluate(script) {
      assert.equal(typeof script, "string");
      if (script.includes("HTMLTextAreaElement.prototype")) {
        state.timeline.push("fill");
        const text = JSON.parse(/setter.call\(el, (.+)\);/.exec(script)[1]);
        return options.truncate ? Math.floor(text.length / 2) : text.length;
      }
      if (script.includes(".ds-toggle-button")) {
        state.timeline.push("thinking");
        const before = state.thinking;
        state.thinking = /state !== (true|false)/.exec(script)[1] === "true";
        return { found: true, state: before };
      }
      if (script.includes("document.body.innerText")) return "";
      if (script.startsWith("Boolean(document.querySelector(")) {
        return state.sends > 0 && options.unfinished && state.stops === 0;
      }
      // Both extractors are evaluated as scripts; Qwen includes the count
      // and Stop control in the same snapshot.
      state.polls++;
      const text = state.sends ? options.unfinished ? `partial tool body ${state.polls}` : "Finished reply." : "";
      const nodes = [{ kind: "text", text }];
      return provider === "qwen" ? {
        nodes, count: state.sends ? 1 : 0, generating: Boolean(state.sends && options.unfinished),
      } : nodes;
    },
  };
  arranged = {
    pages: () => [page], newPage: async () => page,
    on(event, fn) { events[event] = fn; },
    async close() { events.close?.(); },
  };
  return state;
}

for (const [provider, driver, model] of [
  ["deepseek", deepseek, "deepseek"], ["qwen", qwen, "qwen3-max"],
]) {
  test(`${provider}: a deadline with partial text fails and stops generation`, async () => {
    const state = fixture(provider, { unfinished: true });
    await assert.rejects(driver.sendTurn("write the file", { timeoutMs: 1_000 }),
      (e) => e.code === "service-error" && /incomplete reply/.test(e.message));
    assert.equal(state.sends, 1);
    assert.ok(state.stops > 0, "the browser is stopped too, not just its poll loop");
  });

  test(`${provider}: a settled reply still finishes normally`, async () => {
    const state = fixture(provider);
    const reply = await driver.sendTurn("hello", { timeoutMs: 10_000 });
    assert.equal(reply.reply, "Finished reply.");
    assert.equal(state.sends, 1);
    assert.equal(state.stops, 0);
  });

  test(`${provider}: fresh-chat navigation happens before model settings and send`, async () => {
    const state = fixture(provider);
    driver.newChat();
    await driver.sendTurn("hello", { model, fresh: true, thinking: "high", configureThinking: true, timeoutMs: 10_000 });
    const applied = state.timeline.indexOf(provider === "deepseek" ? "thinking" : "model");
    assert.ok(applied > state.timeline.indexOf("navigate"));
    assert.ok(applied < state.timeline.indexOf("send"));
    if (provider === "deepseek") assert.equal(state.thinking, true);
    else assert.equal(state.label, qwen.labelFor(model));
  });

  test(`${provider}: a truncated composer never sends a shortened request`, async () => {
    const state = fixture(provider, { truncate: true });
    await assert.rejects(driver.sendTurn("a complete request with required instructions"),
      (e) => e.code === "message-refused" && /Nothing was sent/.test(e.message));
    assert.equal(state.sends, 0);
  });

  test(`${provider}: cancellation before setup never opens a browser`, async () => {
    process.env.ONFLIP_PROVIDER = provider;
    backoff.__resetPacingForTest();
    arranged = null;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(driver.sendTurn("hello", { signal: abort.signal }), (e) => e.code === "interrupted");
  });
}

test("Qwen: a picker click that fails to change the model prevents sending", async () => {
  const state = fixture("qwen", { refuseModel: true });
  await assert.rejects(qwen.sendTurn("hello", { model: "qwen3-max", fresh: true }),
    (e) => e.code === "invalid-request");
  assert.equal(state.sends, 0);
});

test("Qwen: model selection waits for a picker that mounts after the composer", async () => {
  const state = fixture("qwen", { delayedPicker: true });
  await qwen.sendTurn("hello", { model: "qwen3-max", fresh: true, timeoutMs: 10_000 });
  assert.ok(state.timeline.indexOf("picker-ready") < state.timeline.indexOf("model"));
  assert.equal(state.label, qwen.labelFor("qwen3-max"));
  assert.equal(state.sends, 1);
});

test("Qwen: a cold-page health check waits before reporting missing controls", async () => {
  fixture("qwen", { delayedPicker: true });
  const result = await qwen.checkSelectors();
  assert.equal(result.ok, true);
  assert.equal(result.matches.modelPicker, 1);
});

for (const [status, code] of [[429, "throttled"], [401, "signed-out"], [500, "service-error"]]) {
  test(`DeepSeek: HTTP ${status} is detected without waiting for a response body`, async () => {
    const state = fixture("deepseek", { status, hungBody: true });
    await assert.rejects(deepseek.sendTurn("hello", { timeoutMs: 10_000 }),
      (e) => e.code === code && (status !== 429 || /retry-after: 120/.test(e.message)));
    assert.equal(state.sends, 1);
  });
}

test("DeepSeek: a 429 with a full composer never triggers the send fallback", async () => {
  const state = fixture("deepseek", { status: 429, hungBody: true, refuseLanding: true });
  await assert.rejects(deepseek.sendTurn("hello"), (e) => e.code === "throttled");
  assert.equal(state.sends, 1);
  assert.equal(state.stops, 0, "the shared send/stop button is not pressed again into a throttle");
});

test("DeepSeek: the rolling send limit survives an engine restart", () => {
  process.env.ONFLIP_PROVIDER = "deepseek";
  const file = path.join(process.env.ONFLIP_CONFIG_DIR, "providers", "deepseek", "pacing.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = { lastSendAt: realNow() - 2_000, newChatTimes: [],
    sendTimes: Array.from({ length: 9 }, (_, i) => realNow() - 20_000 + i * 2_000) };
  fs.writeFileSync(file, JSON.stringify(state));
  const script = `
    const driver = require('./dist/providers/deepseek/browser');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    driver.keepToRate(abort.signal).then(() => console.log('accepted'), e => console.log(e.code));
  `;
  const result = execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.trim(), "interrupted");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sendTimes.length, 9);
});

for (const [provider, driver, transportPath, name] of [
  ["deepseek", deepseek, "../dist/providers/deepseek/transport", "DeepSeekTransport"],
  ["qwen", qwen, "../dist/providers/qwen/transport", "QwenTransport"],
]) {
  test(`${provider}: the transport forwards the chosen timeout and fresh model`, async () => {
    process.env.ONFLIP_PROVIDER = provider;
    process.env.ONFLIP_REPLY_TIMEOUT = "123";
    const original = { sendTurn: driver.sendTurn, checkSelectors: driver.checkSelectors };
    let sentOptions;
    const operations = [];
    driver.sendTurn = async (_text, opts) => { operations.push("send"); sentOptions = opts; return { reply: "ok", ms: 1 }; };
    driver.checkSelectors = async () => { operations.push("census"); return { ok: true }; };
    try {
      const Transport = require(transportPath)[name];
      await new Transport().send([{ id: "u", role: "user", content: "hello" }], {
        model: "chosen-model", thinking: "high", signal: new AbortController().signal,
      });
      assert.equal(sentOptions.timeoutMs, 123_000);
      assert.equal(sentOptions.model, "chosen-model");
      assert.equal(sentOptions.fresh, true);
      assert.deepEqual(operations, ["send", "census"]);
    } finally { Object.assign(driver, original); }
  });
}
