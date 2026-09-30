"use strict";

/**
 * The Gemini transport end to end, over a stubbed `fetch`.
 *
 * The scripted-fake technique the suite already uses for `runTurn`, one
 * layer down: the transport's own streaming, retry and truncation behaviour
 * is what these hold, against SSE bodies shaped exactly like the live
 * API's. Nothing here touches the network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-gemini-tr-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ONFLIP_PROVIDER = "gemini";
process.env.ONFLIP_GEMINI_API_KEY = "AIzaSyTest-0000000000000000000000000000";

const { GeminiTransport } = require("../dist/providers/gemini/transport");
const { __resetPacingForTest } = require("../dist/chatgpt/backoff");

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  __resetPacingForTest();
});

const msg = (role, content) => ({ id: Math.random().toString(36).slice(2), role, content });

/** An SSE Response carrying these GenerateContentResponse events. */
function sseResponse(events) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(status, error, headers = {}) {
  return new Response(JSON.stringify({ error }), { status, headers });
}

const textEvent = (text, extra = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, ...extra }],
});

test("a streamed reply is assembled whole, with deltas along the way", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return sseResponse([
      textEvent("Hello, "),
      textEvent("world.", { finishReason: "STOP" }),
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } },
    ]);
  };

  const deltas = [];
  const transport = new GeminiTransport();
  const reply = await transport.send(
    [msg("system", "You are OnFlip."), msg("user", "greet me")],
    {
      model: "gemini-2.5-flash",
      signal: new AbortController().signal,
      onDelta: (t) => deltas.push(t),
    }
  );

  assert.equal(reply.content, "Hello, world.");
  assert.equal(reply.conversationId, null);
  assert.equal(reply.meta, undefined, "a STOP finish is not a truncation");
  assert.deepEqual(deltas.slice(0, 2), ["Hello, ", "Hello, world."]);

  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.match(url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(body.systemInstruction.parts[0].text, "You are OnFlip.");
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "greet me" }] }]);
});

test("a MAX_TOKENS finish is reported as truncated, for the loop's resend path", async () => {
  globalThis.fetch = async () =>
    sseResponse([textEvent("half a file", { finishReason: "MAX_TOKENS" })]);
  const transport = new GeminiTransport();
  const reply = await transport.send([msg("user", "write it")], {
    model: "gemini-2.5-flash",
    signal: new AbortController().signal,
  });
  assert.equal(reply.meta?.truncated, true);
});

test("a short stated wait is honoured once, and the retry succeeds", async () => {
  process.env.ONFLIP_MIN_THROTTLE_SECONDS = "1";
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return errorResponse(429, {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "quota",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" }],
      });
    }
    return sseResponse([textEvent("after the pause", { finishReason: "STOP" })]);
  };
  try {
    const transport = new GeminiTransport();
    const started = Date.now();
    const reply = await transport.send([msg("user", "go")], {
      model: "gemini-2.5-flash",
      signal: new AbortController().signal,
    });
    assert.equal(reply.content, "after the pause");
    assert.equal(call, 2);
    assert.ok(Date.now() - started >= 1_000, "the stated second was actually waited");
  } finally {
    delete process.env.ONFLIP_MIN_THROTTLE_SECONDS;
  }
});

test("a long stated wait is not slept through — it goes up as the throttle it is", async () => {
  globalThis.fetch = async () =>
    errorResponse(429, {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "daily quota",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3600s" }],
    });
  const transport = new GeminiTransport();
  await assert.rejects(
    () =>
      transport.send([msg("user", "go")], {
        model: "gemini-2.5-flash",
        signal: new AbortController().signal,
      }),
    (e) => e.code === "throttled" && /retry-after: 3600/.test(e.message)
  );
});

test("a refused key ends the turn as signed-out, not as a retry loop", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return errorResponse(400, {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "API key not valid. Please pass a valid API key.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    });
  };
  const transport = new GeminiTransport();
  await assert.rejects(
    () =>
      transport.send([msg("user", "go")], {
        model: "gemini-2.5-flash",
        signal: new AbortController().signal,
      }),
    (e) => e.code === "signed-out"
  );
  assert.equal(calls, 1, "a key Google refused is never resent");
});

test("an empty reply is a failure with words, never an empty answer", async () => {
  globalThis.fetch = async () => sseResponse([{ candidates: [{ finishReason: "STOP" }] }]);
  const transport = new GeminiTransport();
  await assert.rejects(
    () =>
      transport.send([msg("user", "go")], {
        model: "gemini-2.5-flash",
        signal: new AbortController().signal,
      }),
    /no text/
  );
});
