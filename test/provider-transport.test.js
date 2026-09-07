"use strict";

/**
 * Which transport a run gets.
 *
 * One `if`, and it is the only place a provider is chosen at run time. The
 * property that matters most is the boring one: with no provider set — every
 * install that predates this — the answer must be exactly what it has always
 * been, chosen by ChatGPT's own logic with its own reasons.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-tr-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_PROVIDER;
delete process.env.ONFLIP_TRANSPORT;
fs.mkdirSync(path.join(HOME, ".onflip"), { recursive: true });
const write = (cfg) => fs.writeFileSync(path.join(HOME, ".onflip", "config.json"), JSON.stringify(cfg));

const { chooseTransport } = require("../dist/providers/transport");
const AUTH = { accessToken: "", cookies: [], deviceId: undefined };

test("no provider set gets ChatGPT's own choice, unchanged", () => {
  write({});
  const { transport, reason } = chooseTransport(AUTH);
  assert.equal(transport.constructor.name, "BrowserTransport");
  assert.equal(reason, "browser profile");
});

test("ChatGPT selected explicitly is the same path", () => {
  write({ provider: "chatgpt" });
  assert.equal(chooseTransport(AUTH).transport.constructor.name, "BrowserTransport");
});

test("a cookie session still reaches ChatGPT's cookie branch", () => {
  // Proof the arguments are passed through rather than reinvented.
  write({ provider: "chatgpt" });
  const { reason } = chooseTransport({ ...AUTH, cookies: [{ name: "x", value: "y" }] });
  assert.equal(reason, "browser session");
});

test("DeepSeek gets its own transport, and needs no token", () => {
  write({ provider: "deepseek" });
  const { transport, reason } = chooseTransport(AUTH);
  assert.equal(transport.constructor.name, "DeepSeekTransport");
  assert.match(reason, /DeepSeek/);
});

test("an unrecognised provider still lands on ChatGPT", () => {
  write({ provider: "gemini" });
  assert.equal(chooseTransport(AUTH).transport.constructor.name, "BrowserTransport");
});

test("both transports satisfy the contract the loop calls", () => {
  write({ provider: "deepseek" });
  const ds = chooseTransport(AUTH).transport;
  write({ provider: "chatgpt" });
  const cg = chooseTransport(AUTH).transport;
  for (const [name, t] of [["deepseek", ds], ["chatgpt", cg]]) {
    assert.equal(typeof t.send, "function", name + " send");
    assert.equal(typeof t.reset, "function", name + " reset");
    assert.equal(typeof t.name, "string", name + " name");
  }
});

// --- the shared files that gained provider guards --------------------------

test("uploads are off by default everywhere, and opt-in never reaches DeepSeek", () => {
  // Every plan types every turn since the Pro-account throttling report —
  // the upload path multiplied backend requests per turn. The env override
  // opts back in, but DeepSeek has no upload path at all, so even the
  // override must not size its compaction budget as though a turn too large
  // to type had somewhere to go.
  const { uploadsAvailable } = require("../dist/chatgpt/transport");

  delete process.env.ONFLIP_UPLOAD_ABOVE;
  write({ provider: "chatgpt" });
  assert.equal(uploadsAvailable(), false, "ChatGPT types every turn by default");

  process.env.ONFLIP_UPLOAD_ABOVE = "45000";
  try {
    write({ provider: "chatgpt" });
    assert.equal(uploadsAvailable(), true, "the env override opts ChatGPT back in");

    write({});
    assert.equal(uploadsAvailable(), true, "and an install with no provider set");

    write({ provider: "deepseek" });
    assert.equal(uploadsAvailable(), false, "DeepSeek types every turn regardless");
  } finally {
    delete process.env.ONFLIP_UPLOAD_ABOVE;
  }
});

test("DeepSeek's ceiling is its own, and far larger than the composer's", () => {
  // DeepSeek's transport applies no clamp and its composer took 200,000
  // characters without truncating, so its ceiling is not a fact about
  // ChatGPT's composer and must never be tied to one.
  const { DEEPSEEK_CEILING_CHARS, COMPOSER_CEILING_CHARS } = require("../dist/chatgpt/plans");
  assert.equal(DEEPSEEK_CEILING_CHARS, 150_000);
  assert.ok(DEEPSEEK_CEILING_CHARS > COMPOSER_CEILING_CHARS);
});

test("ChatGPT's ceiling stays inside what one typed message can carry", () => {
  // The guard that matters: ChatGPT's transport clamps a single message at
  // 80,000 characters, silently, keeping the head and tail and dropping the
  // middle. A fresh thread replays the system prompt plus the transcript, so
  // that sum is what has to stay under the clamp — raising this ceiling to a
  // DeepSeek-sized number would corrupt long conversations invisibly.
  const { COMPOSER_CEILING_CHARS } = require("../dist/chatgpt/plans");
  const CLAMP = 80_000;
  const BIGGEST_SYSTEM_PROMPT = 21_000;
  assert.ok(
    COMPOSER_CEILING_CHARS + BIGGEST_SYSTEM_PROMPT < CLAMP,
    `a fresh-thread replay of ${COMPOSER_CEILING_CHARS + BIGGEST_SYSTEM_PROMPT} would be clamped at ${CLAMP}`
  );
});
