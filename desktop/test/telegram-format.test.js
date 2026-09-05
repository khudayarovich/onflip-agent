"use strict";

/**
 * What the bot puts on the wire.
 *
 * Telegram refuses a whole message when a tag is unbalanced or an entity is
 * wrong, and it does so silently as far as the user is concerned — the reply
 * simply never arrives. So the failures worth guarding are not ugly output
 * but *undeliverable* output: a `<` from a diff, a code block torn in half
 * by the 4096-character limit, an asterisk inside a shell command turning
 * into bold and leaving an open tag behind.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "telegram-format.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const load = () => require(DIST);

/** Every tag opened is closed, in order. Telegram's actual requirement. */
function balanced(html) {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/g)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else {
      stack.push(m[2]);
    }
  }
  return stack.length === 0;
}

// --- escaping --------------------------------------------------------------

test("the three dangerous characters are escaped", { skip: needsBuild }, () => {
  const { escapeHtml } = load();

  assert.equal(escapeHtml('a < b & c > d'), "a &lt; b &amp; c &gt; d");
});

test("a diff does not become a parse error", { skip: needsBuild }, () => {
  // The commonest thing OnFlip sends, and the commonest way to lose a
  // message: an unescaped "<" makes Telegram reject the whole thing.
  const { toTelegramHtml } = load();
  const html = toTelegramHtml("Changed `<div>` to `<section>` in index.html");

  assert.ok(!/(?<!&lt;)<div>/.test(html), html);
  assert.ok(html.includes("&lt;div&gt;"));
  assert.ok(balanced(html));
});

// --- code ------------------------------------------------------------------

test("a fenced block becomes pre/code and keeps its language", { skip: needsBuild }, () => {
  const { toTelegramHtml } = load();
  const html = toTelegramHtml("Try this:\n\n```bash\nnpm test\n```");

  assert.match(html, /<pre><code class="language-bash">npm test<\/code><\/pre>/);
  assert.ok(balanced(html));
});

test("markdown inside a code block is left completely alone", { skip: needsBuild }, () => {
  // An asterisk in a shell glob must not become bold and leave an open tag.
  const { toTelegramHtml } = load();
  const html = toTelegramHtml("```\nrm -rf *.log && echo **done**\n```");

  assert.ok(html.includes("rm -rf *.log &amp;&amp; echo **done**"), html);
  assert.ok(!html.includes("<b>"), "markdown was applied inside code");
  assert.ok(balanced(html));
});

test("inline code survives with its contents escaped once", { skip: needsBuild }, () => {
  const { toTelegramHtml } = load();
  const html = toTelegramHtml("run `a && b < c`");

  assert.ok(html.includes("<code>a &amp;&amp; b &lt; c</code>"), html);
  assert.ok(!html.includes("&amp;amp;"), "escaped twice");
});

// --- inline formatting -----------------------------------------------------

test("bold, italic, headings, bullets and links convert", { skip: needsBuild }, () => {
  const { toTelegramHtml } = load();

  assert.equal(toTelegramHtml("**loud**"), "<b>loud</b>");
  assert.equal(toTelegramHtml("say *quietly* now"), "say <i>quietly</i> now");
  assert.equal(toTelegramHtml("## Results"), "<b>Results</b>");
  assert.equal(toTelegramHtml("- one\n- two"), "• one\n• two");
  assert.equal(
    toTelegramHtml("[docs](https://example.com/a)"),
    '<a href="https://example.com/a">docs</a>'
  );
});

test("snake_case names do not turn half-italic", { skip: needsBuild }, () => {
  // "run some_function_name now" would otherwise italicise the middle and
  // leave the tags in a mess.
  const { toTelegramHtml } = load();
  const html = toTelegramHtml("call some_function_name and other_thing");

  assert.ok(!html.includes("<i>"), html);
  assert.ok(balanced(html));
});

// --- splitting -------------------------------------------------------------

test("a short message is not split", { skip: needsBuild }, () => {
  const { chunkHtml } = load();

  assert.deepEqual(chunkHtml("hello"), ["hello"]);
});

test("a long message splits on line boundaries", { skip: needsBuild }, () => {
  const { chunkHtml } = load();
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const parts = chunkHtml(text, 200);

  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 220, `part was ${p.length}`);
  // Nothing lost.
  assert.equal(parts.join("\n").replace(/\n+/g, "\n"), text);
});

test("a code block split across parts stays balanced in both", { skip: needsBuild }, () => {
  // Half a <pre> is an unbalanced tag, which Telegram rejects outright.
  const { chunkHtml } = load();
  const body = Array.from({ length: 80 }, (_, i) => `const x${i} = ${i};`).join("\n");
  const html = `<pre><code>${body}</code></pre>`;
  const parts = chunkHtml(html, 300);

  assert.ok(parts.length > 1, "expected a split");
  for (const p of parts) assert.ok(balanced(p), `unbalanced part: ${p.slice(0, 80)}`);
});

test("one enormous line is cut rather than made unsendable", { skip: needsBuild }, () => {
  const { chunkHtml } = load();
  const parts = chunkHtml("x".repeat(5000), 1000);

  assert.ok(parts.length >= 5);
  for (const p of parts) assert.ok(p.length <= 1000);
});

test("every part fits what Telegram accepts", { skip: needsBuild }, () => {
  const { answerMessages, TELEGRAM_LIMIT } = load();
  const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of the answer.`).join("\n\n");

  for (const part of answerMessages(long)) {
    assert.ok(part.length <= TELEGRAM_LIMIT, `part was ${part.length}`);
  }
});

// --- the cards -------------------------------------------------------------

test("the status card shows what OnFlip is pointed at", { skip: needsBuild }, () => {
  const { statusCard } = load();
  const card = statusCard({
    cwd: "C:\\Users\\me\\projects\\shop",
    model: "gpt-5-6-mini",
    thinking: "high",
    approvalMode: "auto-edit",
    busy: true,
  });

  assert.match(card, /shop/);
  assert.match(card, /gpt-5-6-mini/);
  assert.match(card, /high/);
  assert.match(card, /auto-edit/);
  assert.match(card, /working/);
  assert.ok(balanced(card));
  // The whole path does not belong in a chat message.
  assert.ok(!card.includes("C:\\Users"), card);
});

test("a tool line is one line and says whether it failed", { skip: needsBuild }, () => {
  const { toolLine } = load();
  const ok = toolLine("bash", "npm test", false);
  const bad = toolLine("edit", "src/app.ts", true);

  assert.ok(!ok.includes("\n"));
  assert.match(ok, /npm test/);
  assert.match(bad, /❌/);
  assert.ok(balanced(ok) && balanced(bad));
});

test("a tool subject with angle brackets stays sendable", { skip: needsBuild }, () => {
  const { toolLine } = load();
  const html = toolLine("grep", "<script> tags", false);

  assert.ok(html.includes("&lt;script&gt;"), html);
  assert.ok(balanced(html));
});

test("elapsed time reads naturally at every scale", { skip: needsBuild }, () => {
  const { elapsedLine } = load();

  assert.match(elapsedLine(8_000), /8s/);
  assert.match(elapsedLine(95_000), /1m 35s/);
  assert.match(elapsedLine(3_930_000), /1h 05m/);
});

test("the help card is valid markup", { skip: needsBuild }, () => {
  const { helpCard } = load();

  assert.ok(balanced(helpCard()));
  assert.match(helpCard(), /\/status/);
});
