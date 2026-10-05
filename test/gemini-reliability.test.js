"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-gemini-reliability-"));
process.env.ONFLIP_CONFIG_DIR = path.join(temp, ".onflip");
process.env.ONFLIP_PROVIDER = "gemini";
process.env.ONFLIP_GEMINI_API_KEY = "AIzaSyTest-0000000000000000000000000000";
const api = require("../dist/providers/gemini/api");
const { GeminiTransport } = require("../dist/providers/gemini/transport");
const backoff = require("../dist/chatgpt/backoff");
const { loadConfig } = require("../dist/config");
const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  backoff.clearCooldown();
  backoff.__resetPacingForTest();
  delete process.env.ONFLIP_MIN_THROTTLE_SECONDS;
});
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const partial = "```onflip\ntool: write\npath: file.txt\ncontent: |\n  unfinished";
const event = (text, finishReason) => ({ candidates: [{ content: { parts: [{ text }] },
  ...(finishReason ? { finishReason } : {}) }] });
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (body) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const request = (signal = new AbortController().signal, timeoutMs = 1_000) => ({
  key: "test-key", model: "gemini-3.1-pro", request: { contents: [] }, signal, timeoutMs,
});

test("Gemini: an EOF or DONE marker without a finish never returns partial tool text", async () => {
  for (const tail of ["", "data: [DONE]\n\n"]) {
    globalThis.fetch = async () => sse(frame(event(partial)) + tail);
    await assert.rejects(api.generateStream(request()), (e) => e.code === "service-error" && /confirmed finish/.test(e.message));
  }
});

test("Gemini: malformed JSON after a partial reply fails instead of skipping an event", async () => {
  globalThis.fetch = async () => sse(frame(event(partial)) + "data: {broken\n\n" + frame(event("rest", "STOP")));
  await assert.rejects(api.generateStream(request()), (e) => e.code === "service-error" && /malformed/.test(e.message));
});

for (const finish of ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "MALFORMED_FUNCTION_CALL"]) {
  test(`Gemini: ${finish} does not return text to the tool parser`, async () => {
    globalThis.fetch = async () => sse(frame(event(partial, finish)));
    await assert.rejects(api.generateStream(request()), (e) => e.code === "invalid-request" && e.message.includes(finish));
  });
}

test("Gemini: an in-stream 429 preserves Google's long retry delay", async () => {
  globalThis.fetch = async () => sse(frame(event(partial)) + frame({ error: {
    code: 429, status: "RESOURCE_EXHAUSTED", message: "quota",
    details: [{ retryDelay: "86400s" }],
  } }));
  await assert.rejects(api.generateStream(request()), (e) => e.code === "throttled" && e.retryAfterSeconds === 86400);
});

test("Gemini: SSE frames can span data lines, CRLF boundaries and UTF-8 byte chunks", async () => {
  const source = ': heartbeat\r\n\r\nevent: message\r\ndata: {"candidates":\r\ndata: [{"content":{"parts":[{"text":"Salom 🌙"}]},"finishReason":"STOP"}]}\r\n\r\n';
  const bytes = new TextEncoder().encode(source);
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  globalThis.fetch = async () => sse(body);
  const reply = await api.generateStream(request());
  assert.equal(reply.text, "Salom 🌙");
  assert.equal(body.locked, false);
});

for (const timeout of [false, true]) {
  test(`Gemini: ${timeout ? "a deadline" : "Stop"} cancels a stalled stream and releases its reader`, async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame(event(partial)))); },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = async () => sse(body);
    const abort = new AbortController();
    // AbortSignal.timeout does not keep Node alive by itself.
    const timer = setTimeout(() => abort.abort(), timeout ? 1_000 : 20);
    try {
      await assert.rejects(api.generateStream(request(abort.signal, timeout ? 20 : 1_000)),
        (e) => e.code === (timeout ? "service-error" : "interrupted"));
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    } finally { clearTimeout(timer); }
  });
}

test("Gemini: Stop before response headers is coded as interrupted", async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20);
  try { await assert.rejects(api.generateStream(request(abort.signal)), (e) => e.code === "interrupted"); }
  finally { clearTimeout(timer); }
});

test("Gemini: thinking configs follow each model family, including models that cannot disable thinking", () => {
  for (const [model, level, expected] of [
    ["gemini-2.5-flash", "off", { thinkingBudget: 0 }],
    ["gemini-2.5-pro", "off", { thinkingBudget: 128 }],
    ["gemini-3.1-pro-preview", "off", { thinkingLevel: "low" }],
    ["gemini-3.6-flash-preview", "off", { thinkingLevel: "minimal" }],
    ["gemini-3.7-flash", "off", { thinkingLevel: "low" }],
    ["gemini-3.8-flash", "off", { thinkingLevel: "low" }],
    ["gemini-3.5-flash-lite", "off", { thinkingLevel: "minimal" }],
    ["gemini-3.1-pro-preview", "high", { thinkingLevel: "high" }],
    ["gemini-4-pro", "high", undefined],
    ["gemma-3-27b-it", "high", undefined],
  ]) {
    const built = api.buildGeminiRequest([{ id: "u", role: "user", content: "hi" }], { model, thinking: level });
    assert.deepEqual(built.generationConfig?.thinkingConfig, expected, model);
  }
});

test("Gemini: model discovery reads every page and escapes its page token", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return Response.json(urls.length === 1 ? {
      models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
      nextPageToken: "next page/&?",
    } : { models: [{ name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] }] });
  };
  const models = await api.discoverGeminiModels("test-key");
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("pageToken"), "next page/&?");
  assert.ok(models.some((m) => m.slug === "gemini-3.1-pro-preview"));
});

test("Gemini: a broken catalogue pagination loop fails instead of saving an incomplete list", async () => {
  let count = 0;
  globalThis.fetch = async () => { count++; return Response.json({ models: [], nextPageToken: "same" }); };
  await assert.rejects(api.discoverGeminiModels("test-key"), (e) => e.code === "service-error");
  assert.equal(count, 2);
});

test("Gemini: catalogue throttles preserve their failure code and full wait", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "daily quota" } }), {
    status: 429, headers: { "retry-after": "86400" },
  });
  await assert.rejects(api.discoverGeminiModels("test-key"), (e) => e.code === "throttled" && e.retryAfterSeconds === 86400);
});

test("Gemini: an HTTP-date Retry-After cannot shorten a longer RetryInfo delay", () => {
  const body = JSON.stringify({ error: { details: [{ retryDelay: "7200s" }] } });
  assert.equal(api.classifyGeminiHttp(429, body, new Date(Date.now() + 3_600_000).toUTCString()).retryAfterSeconds, 7200);
  const long = api.classifyGeminiHttp(429, body, new Date(Date.now() + 86_400_000).toUTCString()).retryAfterSeconds;
  assert.ok(long >= 86399 && long <= 86400);
});

test("Gemini: a service outage leaves the key unverified instead of reporting it invalid", async () => {
  for (const [status, signedIn, reachable] of [[503, false, false], [401, false, true], [429, true, true]]) {
    globalThis.fetch = async () => new Response("{}", { status });
    const checked = await api.checkGeminiKey(process.env.ONFLIP_GEMINI_API_KEY);
    assert.equal(checked.signedIn, signedIn, String(status));
    assert.equal(checked.reachable, reachable, String(status));
  }
});

test("Gemini: a short quota wait stops other windows and Stop prevents the retry", async () => {
  process.env.ONFLIP_MIN_THROTTLE_SECONDS = "1";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { details: [{ retryDelay: "1s" }] } }), { status: 429 });
  };
  const abort = new AbortController();
  const history = [{ id: "u", role: "user", content: "hello" }];
  const first = new GeminiTransport().send(history, { model: "gemini-2.5-flash", signal: abort.signal });
  const rejected = assert.rejects(first, (e) => e.code === "interrupted");
  try {
    for (let i = 0; i < 100 && !(loadConfig().cooldownUntil > Date.now()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(loadConfig().cooldownUntil > Date.now(), "the inline wait is persisted for other engines");
    await assert.rejects(new GeminiTransport().send(history, {
      model: "gemini-2.5-flash", signal: new AbortController().signal,
    }), /Waiting out a Gemini API cooldown/);
    assert.equal(calls, 1);
  } finally { abort.abort(); await rejected; }
  assert.equal(calls, 1, "Stop never produces a second request");
});
