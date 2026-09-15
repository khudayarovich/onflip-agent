"use strict";

/**
 * Qwen as the third service, and the joins that only break at three.
 *
 * Adding a second provider taught the app to ask "is it DeepSeek?" — which,
 * with exactly two services, reads the same as asking the real question and
 * is therefore indistinguishable from correct. At three it stops being
 * correct, and it stops quietly: every `!== "deepseek"` becomes "treat this
 * as ChatGPT", so a Qwen session would have been handed ChatGPT's cookie
 * checks, ChatGPT's project list, ChatGPT's model discovery and a cookie
 * import that cannot work for it.
 *
 * So these are not tests that Qwen exists. They are tests that the questions
 * the app asks are the ones it means.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ONFLIP_PROVIDER = "qwen";
const {
  PROVIDER_IDS,
  providerLabel,
  isBrowserProvider,
  providerStateDir,
  activeProvider,
} = require("../dist/providers/id");
const { allModels, defaultModel, modelBelongsToProvider } = require("../dist/models");
const { chooseTransport } = require("../dist/providers/transport");
const { qwenProfileDir } = require("../dist/providers/qwen/session");
const { deepseekProfileDir } = require("../dist/providers/deepseek/session");

test("it is one of the services the app offers", () => {
  assert.ok(PROVIDER_IDS.includes("qwen"));
  assert.equal(activeProvider(), "qwen", "ONFLIP_PROVIDER pins the run");
});

test("every service has a name of its own", () => {
  // The label table used to have a default — anything that was not DeepSeek
  // was called ChatGPT — which is why a DeepSeek install once showed
  // "ChatGPT" on its own account bar. A missing name is now a compile error,
  // and this is the runtime half of that.
  const labels = PROVIDER_IDS.map((id) => providerLabel(id));
  assert.deepEqual(labels, ["ChatGPT", "DeepSeek", "Qwen", "Arena"]);
  assert.equal(new Set(labels).size, labels.length, "no two services share a name");
});

test("the browser-driven services are the ones without an API behind them", () => {
  assert.equal(isBrowserProvider("chatgpt"), false);
  assert.equal(isBrowserProvider("deepseek"), true);
  assert.equal(isBrowserProvider("qwen"), true);
});

test("no two services share a profile", () => {
  // The whole point of a provider is a separate signed-in account. Two of
  // them in one Chrome profile is one account wearing the other's session,
  // which this app has already shipped once: ChatGPT's whole session
  // duplicated into DeepSeek's room and read straight back as "connected".
  const dirs = [qwenProfileDir(), deepseekProfileDir()];
  assert.equal(new Set(dirs).size, 2, dirs.join(" vs "));
  const states = PROVIDER_IDS.map((id) => providerStateDir(id));
  assert.equal(new Set(states).size, states.length, states.join(" vs "));
});

test("Qwen's transport is Qwen's", () => {
  // The dispatch used to be one `if` with ChatGPT as the fallback, so a
  // service it did not name got ChatGPT's transport — and ChatGPT's cookies
  // with it.
  const chosen = chooseTransport({ accessToken: "", cookies: [], deviceId: undefined });
  assert.match(chosen.reason, /Qwen/);
  assert.equal(chosen.transport.name, "browser");
});

test("the picker offers what the page offers: two models", () => {
  const models = allModels();
  assert.deepEqual(
    models.map((m) => m.slug),
    ["qwen3-plus", "qwen3-max"]
  );
  assert.equal(defaultModel(), "qwen3-plus");
});

test("a model belongs to the service that can serve it", () => {
  // Restoring an old session must not open a ChatGPT slug on Qwen, or a Qwen
  // slug on DeepSeek. The test is coarse on purpose — ChatGPT's list is
  // discovered per account, so a hand-typed slug there is legitimate — and
  // what it refuses is a slug that plainly belongs elsewhere.
  assert.equal(modelBelongsToProvider("qwen3-max"), true);
  assert.equal(modelBelongsToProvider("gpt-5"), false);
  assert.equal(modelBelongsToProvider("deepseek-chat"), false);
});

test("uploads are not offered by a service that has no upload path", () => {
  // The composer types every turn here. Offering the upload route would
  // reach for attachment code that does not exist behind it.
  const { uploadsAvailable } = require("../dist/chatgpt/transport");
  assert.equal(uploadsAvailable(), false);
});

test("a turn is compacted against Qwen's own ceiling, not ChatGPT's plan", () => {
  // Deliberately the conservative figure: nothing has been measured on Qwen,
  // and DeepSeek's much larger ceiling is a number that was earned by a real
  // session running at it. Borrowing it would be borrowing the confidence.
  const { QWEN_CEILING_CHARS, DEEPSEEK_CEILING_CHARS } = require("../dist/chatgpt/plans");
  assert.ok(QWEN_CEILING_CHARS > 0);
  assert.ok(
    QWEN_CEILING_CHARS < DEEPSEEK_CEILING_CHARS,
    "an unmeasured service should not inherit a measured one's headroom"
  );
});
