"use strict";

/**
 * Which addresses the agent's own fetches may reach.
 *
 * From an external review: `web_fetch` and `download_file` took any URL with
 * any method, headers and body, and under full-auto the network permission is
 * granted with no prompt - unlike a shell command, which still meets the
 * allowlist and the danger check. Unguarded that reaches every service bound
 * to this machine, the LAN around it, and 169.254.169.254, where a cloud
 * instance hands its credentials to whatever asks.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { blockedReason, hostBlockedReason } = require("../dist/tools/net-guard");

test("the addresses that must never be reachable", () => {
  const cases = {
    "127.0.0.1": "loopback",
    "127.0.0.53": "loopback",
    "0.0.0.0": "unspecified",
    "10.0.0.5": "private",
    "172.16.0.1": "private",
    "172.31.255.254": "private",
    "192.168.1.1": "private",
    "169.254.169.254": "metadata",
    "100.64.0.1": "carrier-grade",
    "224.0.0.1": "multicast",
    "::1": "loopback",
    "fe80::1": "link-local",
    "fc00::1": "unique-local",
    "fd12:3456::1": "unique-local",
    "::ffff:127.0.0.1": "loopback through an IPv4-mapped address",
  };
  for (const [ip, why] of Object.entries(cases)) {
    assert.ok(blockedReason(ip), `${ip} should be refused (${why})`);
  }
});

test("ordinary public addresses are left alone", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "171.16.0.1", "2606:4700::1111"]) {
    assert.equal(blockedReason(ip), null, ip);
  }
});

test("the edges of each private range are where an off-by-one would hide", () => {
  // 172.16/12 is 172.16 through 172.31 - neither neighbour is private.
  assert.equal(blockedReason("172.15.255.255"), null);
  assert.ok(blockedReason("172.16.0.0"));
  assert.ok(blockedReason("172.31.255.255"));
  assert.equal(blockedReason("172.32.0.0"), null);
  // 100.64/10 is 100.64 through 100.127.
  assert.equal(blockedReason("100.63.255.255"), null);
  assert.ok(blockedReason("100.64.0.0"));
  assert.ok(blockedReason("100.127.255.255"));
  assert.equal(blockedReason("100.128.0.0"), null);
  // 169.254/16 only; 169.253 and 169.255 are ordinary.
  assert.equal(blockedReason("169.253.0.1"), null);
  assert.ok(blockedReason("169.254.0.1"));
  assert.equal(blockedReason("169.255.0.1"), null);
});

test("a hostname is judged by what it resolves to", async () => {
  // localhost is the case a name-only check would miss.
  assert.ok(await hostBlockedReason("localhost"), "localhost resolves to loopback");
  assert.ok(await hostBlockedReason("127.0.0.1"), "a literal is checked directly");
  assert.ok(await hostBlockedReason("[::1]"), "so is a bracketed IPv6 literal");
});

test("a name that does not resolve is not this check's business", async () => {
  // The caller should report the real DNS failure, not a refusal that would
  // send someone hunting for a network policy that is not the problem.
  assert.equal(await hostBlockedReason("no-such-host.invalid"), null);
});

test("the escape hatch opens it for a local server", async () => {
  process.env.ONFLIP_ALLOW_PRIVATE_FETCH = "1";
  try {
    assert.equal(await hostBlockedReason("localhost"), null);
  } finally {
    delete process.env.ONFLIP_ALLOW_PRIVATE_FETCH;
  }
  assert.ok(await hostBlockedReason("localhost"), "and closes again");
});
