"use strict";

/**
 * Gemini as the fourth service, and the first that is an API rather than a
 * browser.
 *
 * `isBrowserProvider` was written as "not ChatGPT" on the stated bet that
 * the next service would be browser-driven too, with the note that a real
 * API would be the case the type system refuses to add quietly. This is that
 * case, and these tests pin the split three ways: Gemini is a provider, it
 * is not a browser provider, and everything browser-shaped — profiles,
 * sign-in windows, cookie imports, page ceilings — stays with the services
 * that have pages.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A home of this test's own, so nothing reads or writes the real ~/.onflip.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-gemini-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ONFLIP_PROVIDER = "gemini";
delete process.env.ONFLIP_GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;

const {
  PROVIDER_IDS,
  providerLabel,
  isBrowserProvider,
  isApiKeyProvider,
  providerStateDir,
  activeProvider,
} = require("../dist/providers/id");
const { allModels, defaultModel, modelBelongsToProvider, effectiveModel, modelContextTokens } =
  require("../dist/models");
const { chooseTransport } = require("../dist/providers/transport");

test("it is one of the services the app offers", () => {
  assert.ok(PROVIDER_IDS.includes("gemini"));
  assert.equal(activeProvider(), "gemini", "ONFLIP_PROVIDER pins the run");
  assert.equal(providerLabel("gemini"), "Gemini API");
});

test("an API-key service is not a browser one, and both predicates say so", () => {
  assert.equal(isBrowserProvider("gemini"), false);
  assert.equal(isApiKeyProvider("gemini"), true);
  // And the carve-out did not move anyone else.
  assert.equal(isBrowserProvider("chatgpt"), false);
  assert.equal(isApiKeyProvider("chatgpt"), false);
  assert.equal(isBrowserProvider("deepseek"), true);
  assert.equal(isApiKeyProvider("deepseek"), false);
  assert.equal(isBrowserProvider("qwen"), true);
  assert.equal(isApiKeyProvider("qwen"), false);
});

test("its state directory is its own", () => {
  const states = PROVIDER_IDS.map((id) => providerStateDir(id));
  assert.equal(new Set(states).size, states.length, states.join(" vs "));
  assert.equal(providerStateDir("gemini"), path.join(HOME, ".onflip", "providers", "gemini"));
});

test("Gemini's transport is Gemini's, and it is not the browser kind", () => {
  const chosen = chooseTransport({ accessToken: "", cookies: [], deviceId: undefined });
  assert.match(chosen.reason, /Gemini/);
  assert.equal(chosen.transport.name, "gemini");
  // Stateless by design: reset has nothing to forget and must not throw.
  chosen.transport.reset();
});

test("the picker offers the published stable aliases, Flash first", () => {
  const models = allModels();
  assert.deepEqual(
    models.map((m) => m.slug),
    ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"]
  );
  assert.equal(defaultModel(), "gemini-2.5-flash");
});

test("a model belongs to the service that can serve it", () => {
  assert.equal(modelBelongsToProvider("gemini-2.5-pro"), true);
  assert.equal(modelBelongsToProvider("gpt-5"), false);
  assert.equal(modelBelongsToProvider("deepseek-chat"), false);
  assert.equal(modelBelongsToProvider("qwen3-max"), false);
});

test("a thinking level never rewrites the slug — the transport carries it", () => {
  // ChatGPT reaches reasoning through variant slugs; Gemini through a
  // request parameter. A `-thinking` suffix here would 404.
  for (const level of [undefined, "off", "low", "medium", "high"]) {
    assert.equal(effectiveModel("gemini-2.5-flash", level), "gemini-2.5-flash");
  }
});

test("the family's window is known, including for a model typed by name", () => {
  assert.equal(modelContextTokens("gemini-2.5-flash"), 1_048_576);
  assert.equal(modelContextTokens("gemini-9-flash"), 1_048_576, "an unknown Gemini still gets the family floor");
});

test("uploads are not offered by a transport that is text-only", () => {
  const { uploadsAvailable } = require("../dist/chatgpt/transport");
  assert.equal(uploadsAvailable(), false);
});

test("a turn is compacted against Gemini's own ceiling, not a composer's", () => {
  // No composer bounds an API request; the free tier's per-minute token
  // rate does. The ceiling should therefore sit well above ChatGPT's typed
  // limits and well below the million-token window.
  const { GEMINI_CEILING_CHARS, COMPOSER_CEILING_CHARS } = require("../dist/chatgpt/plans");
  assert.ok(GEMINI_CEILING_CHARS > COMPOSER_CEILING_CHARS);
  assert.ok(GEMINI_CEILING_CHARS < 1_048_576 * 4);
});

test("the seam answers Gemini with absence, never with ChatGPT's machinery", async () => {
  const seam = require("../dist/providers");
  assert.equal(seam.chatsAreFiled(), false);
  assert.deepEqual(await seam.listProjects([]), []);
  assert.deepEqual(await seam.listConversations([]), []);
  assert.equal(await seam.fetchAccountPlan([]), null);
  assert.equal(seam.currentConversationId(), null);
  assert.equal(await seam.pageSessionUser([]), null);
  assert.deepEqual(await seam.deleteConversations([], ["x"]), { deleted: [], failed: [] });
  assert.equal(seam.finishRealBrowserSignIn(), false);
  assert.equal(seam.cancelRealBrowserSignIn(), false);
  // Nothing to close and nothing to clear — and above all, not ChatGPT's
  // profile. Both must settle without launching anything.
  await seam.closeBrowser();
  await seam.clearBrowserProfile();
  const signIn = await seam.signInWithRealBrowser();
  assert.equal(signIn.ok, false);
  assert.match(signIn.reason, /key/i);
});

test("with no key stored, the probe says so and the transport refuses plainly", async () => {
  const seam = require("../dist/providers");
  const state = await seam.checkSignedIn([]);
  assert.equal(state.signedIn, false);
  assert.equal(state.reachable, true, "a missing key is a fact, not an outage");
  assert.match(state.detail, /aistudio\.google\.com/);

  const { GeminiTransport } = require("../dist/providers/gemini/transport");
  const transport = new GeminiTransport();
  await assert.rejects(
    () =>
      transport.send([{ id: "1", role: "user", content: "hi" }], {
        model: "gemini-2.5-flash",
        signal: new AbortController().signal,
      }),
    (e) => e.code === "signed-out" && /aistudio\.google\.com/.test(e.message)
  );
});

test("attachments are declined out loud, not dropped in silence", () => {
  const seam = require("../dist/providers");
  seam.queueAttachments(["C:\\tmp\\shot.png"]);
  const warning = seam.takeComposerWarning();
  assert.match(warning, /text-only/i);
  // Taken once, like Qwen's.
  assert.equal(seam.takeComposerWarning(), null);
});
