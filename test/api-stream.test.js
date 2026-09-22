"use strict";

/**
 * The direct API path reads its stream as the service writes it.
 *
 * Every frame of the conversation stream carries the whole message so far,
 * not the new piece. Each frame was added to the last, so "Hello, world"
 * arrived as "HelHello, woHello, world" — and that was the reply the parser
 * read, not only what the preview showed. Only `ONFLIP_TRANSPORT=api` takes
 * this path, which is why it went unnoticed.
 *
 * `fetch` is replaced for the length of each test: the sentinel request is
 * refused, as it may be, and the conversation request answers with a
 * scripted event stream. Nothing reaches the network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { sendTurn } = require("../dist/chatgpt/client");

function streamOf(frames) {
  const body = frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function withStream(frames, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes("/sentinel/") ? new Response("no", { status: 403 }) : streamOf(frames);
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const frame = (text, role = "assistant", id = "m-1") => ({
  message: { id, author: { role }, content: { content_type: "text", parts: [text] } },
  conversation_id: "c-1",
});

const send = (progress) =>
  sendTurn([{ id: "u-1", role: "user", content: "say hello" }], {
    accessToken: "token",
    model: "gpt",
    onProgress: progress ? (text) => progress.push(text) : undefined,
  });

test("each frame is the reply so far, not a piece to add", async () => {
  const progress = [];
  const result = await withStream(
    [frame("Hel"), frame("Hello, wo"), frame("Hello, world"), "[DONE]"],
    () => send(progress)
  );
  assert.equal(result.content, "Hello, world");
  assert.deepEqual(progress, ["Hel", "Hello, wo", "Hello, world"], "the preview grows the same way");
  assert.equal(result.messageId, "m-1");
});

test("a tool's message on the same stream is not the reply", async () => {
  const progress = [];
  const result = await withStream(
    [frame("search results: …", "tool", "t-1"), frame("The answer"), frame("The answer is 4."), "[DONE]"],
    () => send(progress)
  );
  assert.equal(result.content, "The answer is 4.");
  assert.deepEqual(progress, ["The answer", "The answer is 4."], "the preview never shows the tool's output as the reply");
  assert.equal(result.messageId, "m-1");
});

test("a frame with no author, or several parts, still reads whole", async () => {
  // The false-positive half: shapes that worked before keep working.
  const bare = { message: { id: "m-2", content: { parts: ["Just ", { text: "text" }] } } };
  const result = await withStream([bare, "[DONE]"], () => send());
  assert.equal(result.content, "Just text");
});
