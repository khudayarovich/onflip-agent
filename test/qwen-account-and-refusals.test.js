"use strict";

/**
 * Qwen: who is signed in comes from Qwen, and a refusal means what it says.
 *
 * - The account's email was the first address-shaped string in the page's
 *   text, and the page is the conversation: a tool result reading
 *   `shop@1.0.0 C:\work\shop` made "shop@1.0.0" the signed-in account. The
 *   `/api/v1/auths/` answer that already decides the session names the
 *   account, so that is where it comes from now.
 * - Every 4xx on any API path meant "signed out": a 429 told the person to
 *   sign in again (the one thing that does not help with a rate limit), and
 *   a failed side request — a GET for a setting — ended a turn whose answer
 *   was on its way.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const qwen = require("../dist/providers/qwen/browser");

/** Run the in-page probe with a token and a scripted fetch. */
async function probe(fetchImpl, token = "tok") {
  const localStorage = { getItem: () => token };
  return new Function("localStorage", "fetch", `return ${qwen.SESSION_PROBE_SCRIPT}`)(localStorage, fetchImpl);
}

test("a live answer carries the account, and it is shown from there", async () => {
  const answer = await probe(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: "u1", name: "Farrukh", email: "farrukh@example.com", token: "x" }),
  }));
  assert.deepEqual(answer, {
    status: 200,
    reached: true,
    account: { name: "Farrukh", email: "farrukh@example.com" },
  });
  assert.deepEqual(qwen.accountFromAuths(answer.account), { name: "Farrukh", email: "farrukh@example.com" });
});

test("a refused or unreachable answer carries none", async () => {
  const refused = await probe(async () => ({ ok: false, status: 401, json: async () => ({ detail: "expired" }) }));
  assert.deepEqual(refused, { status: 401, reached: true, account: null });
  const offline = await probe(async () => {
    throw new Error("offline");
  });
  assert.deepEqual(offline, { status: 0, reached: false });
  assert.deepEqual(qwen.accountFromAuths(null), {});
  assert.deepEqual(qwen.accountFromAuths({ name: 42, email: "not an address" }), {});
});

test("the page's text is never read for an email", async () => {
  // The page is the conversation. Whatever address-shaped text it holds,
  // the account reader returns a name from the account control or nothing.
  const document = {
    querySelector: () => null,
    body: { innerText: "fix the build\nshop@1.0.0 C:\\work\\shop\nwrite to boss@company.com" },
  };
  const page = { evaluate: async (src) => new Function("document", `return ${src}`)(document) };
  assert.deepEqual(await qwen.readProfile(page), {});
});

test("a refusal is read by its status", () => {
  const code = (status, body = "") => qwen.refusalCode({ status, body });
  assert.equal(code(401), "signed-out");
  assert.equal(code(403, "Your session has expired, or the token is no longer valid."), "signed-out");
  assert.equal(code(403, "Request blocked by risk control"), "refused");
  assert.equal(code(429, "Too many requests"), "throttled");
  for (const status of [400, 404, 413, 500, 502]) assert.equal(code(status), "service-error", String(status));
});

test("a failed side read is not the turn's refusal; a failed send is", async () => {
  const context = new EventEmitter();
  qwen.watchApi(context);
  const respond = (method, status, path) =>
    context.emit("response", {
      url: () => `https://chat.qwen.ai${path}`,
      status: () => status,
      request: () => ({ method: () => method }),
      text: async () => "body",
    });
  const settle = () => new Promise((r) => setImmediate(r));

  const before = qwen.__lastApiFailureForTest();
  respond("GET", 404, "/api/v1/settings");
  await settle();
  assert.equal(qwen.__lastApiFailureForTest(), before, "a GET 404 was recorded as a refusal");

  respond("POST", 429, "/api/v2/chat/completions");
  await settle();
  assert.deepEqual(
    { status: qwen.__lastApiFailureForTest()?.status, path: qwen.__lastApiFailureForTest()?.path },
    { status: 429, path: "/api/v2/chat/completions" }
  );

  respond("GET", 401, "/api/v1/auths/");
  await settle();
  assert.equal(qwen.__lastApiFailureForTest()?.status, 401, "a refused credential counts whatever asked");
});
