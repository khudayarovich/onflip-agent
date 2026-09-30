"use strict";

/**
 * The ChatGPT cookie RPCs guard themselves on another service.
 *
 * `applySignIn` and `importBrowserSession` only ever handle ChatGPT
 * sessions. The UI hides their buttons off ChatGPT and the main process
 * refuses its own sign-in route, but both are exposed engine RPCs — and run
 * under DeepSeek, Qwen or Gemini they would report that service signed in
 * on the strength of a ChatGPT cookie and file the ChatGPT account's name
 * into that service's config room, which is the cross-service identity bug
 * this app has shipped twice. An exposed RPC guards itself.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "engine", "engine.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-guards-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "gemini";
delete process.env.ONFLIP_GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;

function makeEngine() {
  const { Engine } = require(DIST);
  const work = fs.mkdtempSync(path.join(HOME, "work-"));
  const peer = { emit() {}, request: async () => ({}) };
  return new Engine(peer, work);
}

test("applySignIn refuses off ChatGPT rather than filing its identity", { skip: needsBuild }, async () => {
  const engine = makeEngine();
  await assert.rejects(
    () =>
      engine.applySignIn([{ name: "__Secure-next-auth.session-token", value: "x".repeat(40) }], {
        name: "A ChatGPT Person",
        email: "person@example.com",
      }),
    /ChatGPT session/
  );
  // The refusal must have written nothing: no identity in Gemini's room,
  // no session keys anywhere new. A config file that never appeared proves
  // the same thing.
  const cfgPath = path.join(process.env.ONFLIP_CONFIG_DIR, "config.json");
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  assert.equal(cfg.providers?.gemini?.accountName, undefined);
  assert.equal(cfg.sessionToken, undefined);
});

test("importBrowserSession declines off ChatGPT, naming the way in", { skip: needsBuild }, async () => {
  const engine = makeEngine();
  const result = await engine.importBrowserSession();
  assert.equal(result.ok, false);
  assert.match(result.reason, /ChatGPT sessions/);
  assert.match(result.reason, /account menu/);
});
