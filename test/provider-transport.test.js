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
