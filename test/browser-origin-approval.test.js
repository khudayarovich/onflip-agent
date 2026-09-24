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
    "ftp://127.0.0.1/",
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

// --- a page in the working folder -------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { localPageUrl } = require("../dist/tools/browser");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-local-page-"));
fs.writeFileSync(path.join(work, "index.html"), "<!doctype html><title>board</title>");

test("a page in the working folder opens as a file, by path or by URL", () => {
  // DeepSeek wrote a self-contained game and tried to look at it: the
  // file:// URL was refused, and a web server was the only way left.
  const byPath = localPageUrl("index.html", work);
  assert.equal(byPath.url.href, pathToFileURL(path.join(work, "index.html")).href);
  const byUrl = localPageUrl(pathToFileURL(path.join(work, "index.html")).href, work);
  assert.equal(byUrl.url.href, byPath.url.href);
});

test("a file outside the working folder is refused by name", () => {
  const outside = pathToFileURL(path.join(os.homedir(), ".ssh", "id_rsa")).href;
  assert.match(localPageUrl(outside, work).error, /outside it/);
});

test("a link inside the working folder that leads out of it is refused", (t) => {
  // Lexically `work/linked/page.html` is inside; the page it opens is not.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-elsewhere-"));
  fs.writeFileSync(path.join(elsewhere, "page.html"), "<title>not the project's</title>");
  try {
    fs.symlinkSync(elsewhere, path.join(work, "linked"), "junction");
  } catch (e) {
    t.skip(`no link can be made here (${e.code})`);
    return;
  }
  assert.match(localPageUrl("linked/page.html", work).error, /outside it/);
  assert.match(localPageUrl(pathToFileURL(path.join(work, "linked", "page.html")).href, work).error, /outside it/);
});

test("anything else is left to be read as a web address", () => {
  assert.equal(localPageUrl("https://example.com", work), null);
  assert.equal(localPageUrl("example.com", work), null);
  assert.equal(localPageUrl("missing.html", work), null);
});

test("pages opened from files can be approved once, like a local server", () => {
  assert.equal(loopbackOrigin(pathToFileURL(path.join(work, "index.html")).href), "file://");
  const policy = createPolicy(work, "ask");
  const page = pathToFileURL(path.join(work, "index.html")).href;
  assert.equal(evaluate(policy, click(page)).outcome, "ask");
  remember(policy, click(page));
  assert.equal(evaluate(policy, click(page)).outcome, "allow");
});
