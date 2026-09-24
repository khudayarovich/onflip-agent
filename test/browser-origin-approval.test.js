"use strict";

/**
 * "Always allow" for the agent's browser, on this machine's own pages only.
 *
 * Checking a page the agent had just started with `npm run dev` asked once
 * per click: four prompts for one look at a chess board, in the mode a Mac
 * is limited to (ask or auto-edit). A remembered local origin clears those;
 * a site on the internet keeps asking, because the agent's browser keeps
 * whatever logins were made in it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loopbackOrigin, createPolicy, evaluate, remember } = require("../dist/agent/permissions");

const click = (origin) => ({ kind: "network", tool: "browser_click", subject: "click Select e2", origin });

test("this machine's own servers are loopback origins, whatever the spelling", () => {
  assert.equal(loopbackOrigin("http://127.0.0.1:5173/"), "http://127.0.0.1:5173");
  assert.equal(loopbackOrigin("http://localhost:3000/board?x=1"), "http://localhost:3000");
  assert.equal(loopbackOrigin("http://app.localhost:8080"), "http://app.localhost:8080");
  assert.equal(loopbackOrigin("http://[::1]:4000/"), "http://[::1]:4000");
  assert.equal(loopbackOrigin("http://127.1.2.3/"), "http://127.1.2.3");
});

test("anything else is not", () => {
  for (const url of [
    "https://chatgpt.com/",
    "http://192.168.1.1/",
    "http://127.0.0.1.evil.example/",
    "http://localhost.evil.example/",
    "file:///C:/index.html",
    "not a url",
    undefined,
  ]) {
    assert.equal(loopbackOrigin(url), null, String(url));
  }
});

test("a remembered local origin clears later actions on that origin only", () => {
  const policy = createPolicy("/work", "ask");
  assert.equal(evaluate(policy, click("http://127.0.0.1:5173/")).outcome, "ask");
  remember(policy, click("http://127.0.0.1:5173/"));
  assert.equal(evaluate(policy, click("http://127.0.0.1:5173/board")).outcome, "allow");
  // Another port is another server.
  assert.equal(evaluate(policy, click("http://127.0.0.1:3000/")).outcome, "ask");
});

test("a site on the internet is never remembered, even when asked to", () => {
  const policy = createPolicy("/work", "auto-edit");
  remember(policy, click("https://example.com/"));
  assert.equal(policy.allowedOrigins.size, 0);
  assert.equal(evaluate(policy, click("https://example.com/")).outcome, "ask");
});

test("a stored list cannot smuggle in a remote origin", () => {
  const policy = createPolicy("/work", "ask", {
    origins: ["http://localhost:5173", "https://bank.example"],
  });
  assert.deepEqual([...policy.allowedOrigins], ["http://localhost:5173"]);
});

test("read-only still refuses the browser, remembered or not", () => {
  const policy = createPolicy("/work", "read-only", { origins: ["http://localhost:5173"] });
  assert.equal(evaluate(policy, click("http://localhost:5173/")).outcome, "deny");
});
