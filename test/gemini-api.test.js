"use strict";

/**
 * The Gemini client's pure parts, held against real payload shapes.
 *
 * Everything here is exported precisely so it can be tested without a key
 * or a network: the request builder (which owns the role mapping and the
 * merge rule), the failure classifier (which owns retry-versus-cooldown),
 * the thinking-budget table, and the SSE buffer arithmetic — the places a
 * quiet mistake would cost a live session an afternoon.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-gemini-api-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ONFLIP_PROVIDER = "gemini";

const {
  buildGeminiRequest,
  thinkingBudgetFor,
  classifyGeminiHttp,
  looksLikeGeminiKey,
  cleanGeminiKeyPaste,
  drainSseBuffer,
  eventText,
} = require("../dist/providers/gemini/api");
const { classifyFailure, isThrottle } = require("../dist/chatgpt/backoff");

const msg = (role, content) => ({ id: Math.random().toString(36).slice(2), role, content });

// --- the request ------------------------------------------------------------

test("the system prompt travels as systemInstruction, never as a turn", () => {
  const req = buildGeminiRequest(
    [msg("system", "You are OnFlip."), msg("user", "hi")],
    { model: "gemini-2.5-flash" }
  );
  assert.equal(req.systemInstruction.parts[0].text, "You are OnFlip.");
  assert.deepEqual(req.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
});

test("assistant turns become model turns, and consecutive same-role turns merge", () => {
  // A tool result rides the user role and is routinely followed by the next
  // user message; Gemini takes them as one turn.
  const req = buildGeminiRequest(
    [
      msg("system", "sys"),
      msg("user", "do the thing"),
      msg("assistant", "```onflip\ntool: bash\n```"),
      { ...msg("user", "exit 0"), toolName: "bash" },
      msg("user", "now finish"),
    ],
    { model: "gemini-2.5-flash" }
  );
  assert.deepEqual(
    req.contents.map((c) => c.role),
    ["user", "model", "user"]
  );
  assert.match(req.contents[2].parts[0].text, /exit 0\n\nnow finish/);
});

test("the reminder lands at the end of the final user turn", () => {
  const req = buildGeminiRequest([msg("system", "sys"), msg("user", "hi")], {
    model: "gemini-2.5-flash",
    reminder: "[protocol reminder]",
  });
  assert.match(req.contents[0].parts[0].text, /hi\n\n\[protocol reminder\]$/);
});

test("a conversation ending on the model still ends on a user turn", () => {
  // The API generates the next model turn; handed a history that ends on
  // one, it would be asked to continue its own sentence.
  const req = buildGeminiRequest([msg("user", "a"), msg("assistant", "b")], {
    model: "gemini-2.5-flash",
  });
  assert.equal(req.contents[req.contents.length - 1].role, "user");
});

test("empty messages are dropped rather than sent as blank turns", () => {
  const req = buildGeminiRequest(
    [msg("user", "a"), msg("assistant", "   "), msg("user", "b")],
    { model: "gemini-2.5-flash" }
  );
  assert.deepEqual(
    req.contents.map((c) => c.role),
    ["user"]
  );
  assert.match(req.contents[0].parts[0].text, /a\n\nb/);
});

// --- thinking ---------------------------------------------------------------

test("no chosen level sends no thinking config at all", () => {
  // The safe default for a model typed by name, whose accepted range is
  // unknown: its own defaults, not ours.
  assert.equal(thinkingBudgetFor("gemini-2.5-flash", undefined), undefined);
  assert.equal(thinkingBudgetFor("gemini-2.5-flash", ""), undefined);
  const req = buildGeminiRequest([msg("user", "hi")], { model: "gemini-2.5-flash" });
  assert.equal(req.generationConfig, undefined);
});

test("off is 0 — except on Pro, which cannot switch thinking off", () => {
  assert.equal(thinkingBudgetFor("gemini-2.5-flash", "off"), 0);
  // 128 is Pro's published minimum; 0 there is a 400 error, not a setting.
  assert.equal(thinkingBudgetFor("gemini-2.5-pro", "off"), 128);
  assert.equal(thinkingBudgetFor("gemini-2.5-flash", "high"), 24576);
  assert.ok(thinkingBudgetFor("gemini-2.5-flash", "low") < thinkingBudgetFor("gemini-2.5-flash", "medium"));
});

// --- the failure taxonomy ---------------------------------------------------

test("a 429 is a throttle carrying Google's own stated wait", () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota.",
      details: [
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "28s" },
      ],
    },
  });
  const c = classifyGeminiHttp(429, body);
  assert.equal(c.code, "throttled");
  assert.equal(c.retryAfterSeconds, 28);
  // The spelling the shared classifier reads, so the cooldown honours the
  // server's figure rather than a default.
  assert.match(c.message, /retry-after: 28/);
  const verdict = classifyFailure(c.message, c.code);
  assert.equal(verdict.kind, "cooldown");
  assert.equal(verdict.seconds, 30, "floored at the minimum throttle, above the stated 28");
  assert.equal(isThrottle(c.message, c.code), true, "a quota pause passes by itself");
});

test("a refused key is signed-out — fatal, with the fix named", () => {
  const body = JSON.stringify({
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "API key not valid. Please pass a valid API key.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    },
  });
  const c = classifyGeminiHttp(400, body);
  assert.equal(c.code, "signed-out");
  assert.match(c.message, /aistudio\.google\.com/);
  assert.equal(classifyFailure(c.message, c.code).kind, "fatal");
});

test("a 401 and a bare 403 read as a refused key too", () => {
  assert.equal(classifyGeminiHttp(401, "").code, "signed-out");
  assert.equal(classifyGeminiHttp(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "denied" } })).code, "signed-out");
});

test("a 500 carries no code, which is one retry — the right answer for it", () => {
  const c = classifyGeminiHttp(500, JSON.stringify({ error: { status: "INTERNAL", message: "boom" } }));
  assert.equal(c.code, undefined);
  assert.equal(classifyFailure(c.message, c.code).kind, "retry");
});

test("an unknown model names itself and the way out", () => {
  const c = classifyGeminiHttp(404, JSON.stringify({ error: { status: "NOT_FOUND", message: "models/gemini-x is not found" } }));
  assert.equal(c.code, undefined);
  assert.match(c.message, /model/i);
  assert.match(c.message, /chip under the composer/);
});

test("a body that is not JSON still produces a readable message", () => {
  const c = classifyGeminiHttp(503, "<html>Service Unavailable</html>");
  assert.match(c.message, /HTTP 503/);
});

// --- the key's shape --------------------------------------------------------

test("a paste that is plainly not a key is refused before Google sees it", () => {
  assert.equal(looksLikeGeminiKey("AIzaSyD-8f2kQ9x7wLmNopQRstuVWxyZ0123456"), true);
  assert.equal(looksLikeGeminiKey("  AIzaSyD-8f2kQ9x7wLmNopQRstuVWxyZ0123456  "), true, "trimmed");
  assert.equal(looksLikeGeminiKey("my key is AIza123"), false, "a sentence");
  assert.equal(looksLikeGeminiKey("https://aistudio.google.com/apikey"), false, "the page, not the key");
  assert.equal(looksLikeGeminiKey("short"), false);
  assert.equal(looksLikeGeminiKey(""), false);
});

test("the key is found inside what people actually paste", () => {
  // Live within the hour of shipping the field: a real paste refused as
  // "not a key". These are the shapes a key arrives in.
  const KEY = "AIzaSyD-8f2kQ9x7wLmNopQRstuVWxyZ0123456";
  assert.equal(cleanGeminiKeyPaste(KEY), KEY, "a clean paste is untouched");
  assert.equal(cleanGeminiKeyPaste(`  ${KEY}\n`), KEY, "stray whitespace");
  assert.equal(cleanGeminiKeyPaste(`"${KEY}"`), KEY, "quotes from a config file");
  assert.equal(cleanGeminiKeyPaste(`GEMINI_API_KEY=${KEY}`), KEY, "an .env line");
  assert.equal(cleanGeminiKeyPaste(`API key: ${KEY}`), KEY, "a labelled copy");
  assert.equal(
    cleanGeminiKeyPaste(`${KEY.slice(0, 20)}\n${KEY.slice(20)}`),
    KEY,
    "a key a chat window wrapped across lines"
  );
  assert.equal(cleanGeminiKeyPaste(`​${KEY}﻿`), KEY, "invisible characters from a web copy");
});

test("but a paste with no key in it, or two, is still refused", () => {
  const KEY = "AIzaSyD-8f2kQ9x7wLmNopQRstuVWxyZ0123456";
  const OTHER = "AIzaSyOther-key-000000000000000000000000";
  // AI Studio's list shows keys shortened; copying the display copies a
  // literal "…" that is not the key, and must not be "rescued" into one.
  assert.equal(looksLikeGeminiKey(cleanGeminiKeyPaste("AIza...Z456")), false, "the shortened display");
  assert.equal(looksLikeGeminiKey(cleanGeminiKeyPaste("please paste your api key here")), false, "a sentence");
  assert.equal(
    looksLikeGeminiKey(cleanGeminiKeyPaste(`${KEY} or ${OTHER}`)),
    false,
    "two different keys are ambiguous, not a guess"
  );
  // The same key twice is one candidate, not an ambiguity.
  assert.equal(cleanGeminiKeyPaste(`${KEY} ${KEY}`), KEY);
});

// --- the stream -------------------------------------------------------------

test("SSE events split across reads are reassembled, not lost", () => {
  const first = drainSseBuffer('data: {"a":1}\ndata: {"b"');
  assert.deepEqual(first.events, ['{"a":1}']);
  assert.equal(first.rest, 'data: {"b"');
  const second = drainSseBuffer(first.rest + ':2}\n');
  assert.deepEqual(second.events, ['{"b":2}']);
  assert.equal(second.rest, "");
});

test("only visible text counts; thought parts are not the answer", () => {
  const event = {
    candidates: [
      {
        content: {
          parts: [
            { text: "planning the move", thought: true },
            { text: "Here is the file:" },
          ],
        },
      },
    ],
  };
  assert.equal(eventText(event), "Here is the file:");
  assert.equal(eventText({}), "");
});
