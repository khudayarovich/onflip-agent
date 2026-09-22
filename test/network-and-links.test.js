"use strict";

/**
 * Three ways out that the guards did not see, each reproduced first.
 *
 * - `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`,
 *   and the guard only knew the dotted spelling of a mapped address — so
 *   `web_fetch` reached loopback, and `[::ffff:a9fe:a9fe]` the cloud
 *   metadata service. Measured against a live loopback server before the fix.
 * - `download_file` asked only to write, never to reach the network, so in
 *   auto-edit it could send anything anywhere in a URL with no prompt while
 *   `web_fetch` of the same URL asked.
 * - A symlink whose target did not exist yet kept its in-workspace name in
 *   the containment check, and the write followed it out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { blockedReason, withoutCredentials } = require("../dist/tools/net-guard");
const { createPolicy, evaluate, realPath } = require("../dist/agent/permissions");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");

const hostOf = (url) => new URL(url).hostname.replace(/^\[|\]$/g, "");

test("an IPv6 spelling of a private IPv4 address is refused, as the URL parser writes it", () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]:8080/admin",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::10.0.0.1]/",
    "http://[2002:7f00:1::]/",
    "http://[fec0::1]/",
    "http://[ff02::1]/",
  ]) {
    assert.ok(blockedReason(hostOf(url)), `${url} → ${hostOf(url)} should be refused`);
  }
});

test("public addresses, in either family, still pass", () => {
  for (const ip of ["93.184.216.34", "::ffff:93.184.216.34", "2606:4700:4700::1111", "64:ff9b::5db8:d822"]) {
    assert.equal(blockedReason(ip), null, ip);
  }
});

test("a redirect to another origin does not carry the caller's credentials", () => {
  const kept = withoutCredentials({ Authorization: "Bearer x", Cookie: "a=b", Accept: "text/html" });
  assert.deepEqual(Object.keys(kept).map((k) => k.toLowerCase()), ["accept"]);
});

test("and the redirect loop actually drops them at the origin change", async () => {
  const http = require("node:http");
  const { fetchPublic } = require("../dist/tools/net-guard");
  let seen = null;
  const target = http.createServer((req, res) => {
    seen = req.headers;
    res.end("ok");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const bounce = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/landing` });
    res.end();
  });
  await new Promise((resolve) => bounce.listen(0, "127.0.0.1", resolve));
  // Loopback is what the guard exists to refuse; this test needs it.
  process.env.ONFLIP_ALLOW_PRIVATE_FETCH = "1";
  try {
    const res = await fetchPublic(new URL(`http://127.0.0.1:${bounce.address().port}/start`), {
      headers: { Authorization: "Bearer secret", "X-Kept": "yes" },
    });
    await res.text();
  } finally {
    delete process.env.ONFLIP_ALLOW_PRIVATE_FETCH;
    target.close();
    bounce.close();
  }
  assert.ok(seen, "the redirect was followed");
  assert.equal(seen.authorization, undefined);
  assert.equal(seen["x-kept"], "yes");
});

test("a download asks to reach the network, the way a fetch of the same URL does", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-dl-"));
  const asked = [];
  const tools = createToolRegistry({
    cwd,
    session: createSessionState(),
    signal: new AbortController().signal,
    // Refuse the first question so nothing is actually fetched.
    requestPermission: async (req) => {
      asked.push(req.kind);
      return { allow: false, reason: "no" };
    },
  });
  const r = await tools.run("download_file", { url: "https://example.com/x?secret=1", path: "x.bin" });
  assert.ok(r.denied);
  assert.deepEqual(asked, ["network"], "the network is asked about before anything else");
  const policy = createPolicy(cwd, "auto-edit");
  assert.equal(evaluate(policy, { kind: "network", tool: "download_file", subject: "GET https://example.com" }).outcome, "ask");
});

test("a write into a linked folder that does not exist yet is outside", () => {
  // A directory junction needs no privilege on Windows, so this one runs
  // everywhere; the file-link case below needs one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-dirlink-"));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace);
  const link = path.join(workspace, "out");
  fs.symlinkSync(path.join(root, "elsewhere"), link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "stolen.txt");
  assert.ok(!realPath(target).startsWith(realPath(workspace)), realPath(target));
  const verdict = evaluate(createPolicy(workspace, "auto-edit"), {
    kind: "write",
    tool: "write",
    subject: target,
    targetPath: target,
  });
  assert.equal(verdict.outcome, "ask");
});

test("a write through a link to somewhere that does not exist yet is outside", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-link-"));
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace);
  const outside = path.join(root, "elsewhere", "stolen.txt");
  const link = path.join(workspace, "notes.txt");
  try {
    fs.symlinkSync(outside, link, "file");
  } catch (e) {
    t.skip(`symlinks cannot be created here (${e.code})`);
    return;
  }
  assert.equal(realPath(link), path.join(realPath(path.join(root, "elsewhere")), "stolen.txt"));
  const policy = createPolicy(workspace, "auto-edit");
  const verdict = evaluate(policy, { kind: "write", tool: "write", subject: link, targetPath: link });
  assert.equal(verdict.outcome, "ask", "not cleared as a workspace edit");
});
