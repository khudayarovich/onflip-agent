"use strict";

/**
 * A file that holds its own code block is written whole, or not at all.
 *
 * Found in a Markdown document OnFlip wrote on another machine: 1,912 bytes,
 * ending on the last line of its first diagram, with the diagram's closing
 * fence gone and every section after it missing. The model wrote it whole;
 * the chat's renderer ended the three-backtick onflip block at the
 * document's own "```" line, and the reply read back off the page carried the
 * file only up to there. See `fence-cut.ts`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-fence-cut-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const { pageLostPartOfTheReply, endsInsideCodeBlock } = require("../dist/agent/fence-cut");
const { parseTurn } = require("../dist/agent/protocol");
const { runTurn } = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");

/** The document as the model meant it, the shape of the one that was cut. */
const DOC = [
  "# OnFlip — Suggestions",
  "",
  "## 2. Core Architectural Direction",
  "",
  "```text",
  "User",
  "  |",
  "  +--> Failure --> Diagnose --> Repair --> Retry",
  "```",
  "",
  "## 3. Verification",
  "",
  "OnFlip runs the project's own checks before it says done.",
];
const indent = (lines) => lines.map((l) => (l ? `  ${l}` : "")).join("\n");

/** The reply as the model typed it: the stream's copy. */
const RAW = ["```onflip", "tool: write", "path: SUGGESTIONS.md", "content: |", indent(DOC), "```"].join("\n");
/**
 * The same reply read back off the page: the renderer ended the block at the
 * document's own closing fence, the rest became prose, and the model's real
 * closing fence opened an empty block that the extractor leaves out.
 */
const PAGE = ["```onflip", "tool: write", "path: SUGGESTIONS.md", "content: |", indent(DOC.slice(0, 8)), "```", "", "## 3. Verification", "", "OnFlip runs the project's own checks before it says done."].join("\n");

test("the page's copy is the cut file, and the stream's is the whole one", () => {
  const page = parseTurn(PAGE).calls[0].arguments.content;
  const stream = parseTurn(RAW).calls[0].arguments.content;
  assert.ok(page.endsWith("Retry"), JSON.stringify(page.slice(-40)));
  assert.equal(stream, DOC.join("\n"));
  assert.equal(pageLostPartOfTheReply(PAGE, RAW), true);
});

test("the page's copy stays the reply unless it lost something", () => {
  // Identical, and different only outside the calls.
  assert.equal(pageLostPartOfTheReply(RAW, RAW), false);
  assert.equal(pageLostPartOfTheReply(`Writing it now.\n\n${RAW}`, `Writing it now, whole.\n\n${RAW}`), false);
  // The stream's fence line carries an id the page's label drops: the same reply.
  assert.equal(pageLostPartOfTheReply(RAW, RAW.replace("```onflip", '```onflip id="k2m8qa"')), false);
  // A value that differs otherwise is the page's to keep: nothing says it was lost.
  assert.equal(pageLostPartOfTheReply(RAW, RAW.replace("Diagnose", "Diagnosis")), false);
  // The page holding more than the stream is not the stream's to override.
  assert.equal(pageLostPartOfTheReply(RAW, PAGE), false);
  // A stream with no call in it has nothing to offer a call.
  assert.equal(pageLostPartOfTheReply(RAW, "I will write it next."), false);
});

test("a call the page lost whole, or a value it never had, is loss too", () => {
  const read = "```onflip\ntool: read\npath: a.txt\n```";
  assert.equal(pageLostPartOfTheReply(read, `${read}\n\n${read.replace("a.txt", "b.txt")}`), true);
  const edit = (tail) => `\`\`\`onflip\ntool: edit\npath: a.md\nold_string: |\n  one\n${tail}\`\`\``;
  assert.equal(pageLostPartOfTheReply(edit(""), edit("new_string: |\n  two\n")), true);
});

test("the stream's copy goes up with a reply only when it is the whole reply", () => {
  const browser = require("../dist/chatgpt/browser-client");
  const sse = (status) =>
    [
      `data: ${JSON.stringify({
        v: { message: { id: "a1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [RAW] }, status } },
      })}`,
      "data: [DONE]",
    ]
      .map((line) => `${line}\n\n`)
      .join("");
  let before = browser.__setStreamForTest(null);
  browser.__setStreamFromSseForTest(sse("finished_successfully"));
  assert.equal(browser.replyMetaFor(before, null, 0).streamText, RAW);
  // After "Continue generating" the stream holds only the second half.
  assert.equal("streamText" in browser.replyMetaFor(before, null, 1), false);
  // A message the stream never saw finish is not the reply.
  before = browser.__setStreamForTest(null);
  browser.__setStreamFromSseForTest(sse("in_progress"));
  assert.equal("streamText" in browser.replyMetaFor(before, null, 0), false);
  browser.__setStreamForTest(null);
});

test("a file change that ends inside an open code block is recognised", () => {
  assert.equal(endsInsideCodeBlock("write", { content: DOC.slice(0, 8).join("\n") }), "content");
  assert.equal(endsInsideCodeBlock("write", { content: DOC.join("\n") }), null);
  assert.equal(endsInsideCodeBlock("edit", { old_string: "x", new_string: "```js\nlet a;" }), "new_string");
  assert.equal(
    endsInsideCodeBlock("multi_edit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "~ ```sh\n```bash\nls" }] }),
    "edits[1].new_string"
  );
  // The false-positive half: what renders as no fence, and what is not a file.
  assert.equal(endsInsideCodeBlock("write", { content: "````md\n```js\nx\n```\n````" }), null, "a longer fence holds a shorter one");
  assert.equal(endsInsideCodeBlock("write", { content: "code:\n\n    ```\n    indented four is code, not a fence" }), null);
  assert.equal(endsInsideCodeBlock("write", { content: "inline ```code``` in a line" }), null);
  assert.equal(endsInsideCodeBlock("edit", { old_string: "```js\nopen", new_string: "closed" }), null, "only the new text is judged");
  assert.equal(endsInsideCodeBlock("bash", { command: "echo ```" }), null);
});

// ---------------------------------------------------------------------------
// whole turns
// ---------------------------------------------------------------------------

const said = (role, content) => ({ id: `${role}-${Math.random()}`, role, content });
const DONE = "````onflip\ntool: done\nsummary: |\n  Wrote it.\n````";

async function turn(replies) {
  const dir = fs.mkdtempSync(path.join(HOME, "ws-"));
  const session = createSessionState();
  const tools = createToolRegistry({
    cwd: dir,
    session,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });
  const sent = [];
  const history = [said("system", "prompt"), said("user", "write the suggestions down")];
  const transport = {
    name: "api",
    async send(h) {
      sent.push(h[h.length - 1].content);
      const next = replies.shift();
      return typeof next === "string" ? { content: next, conversationId: null } : { conversationId: null, ...(next ?? { content: DONE }) };
    },
    reset() {},
  };
  const result = await runTurn(history, {
    transport,
    tools,
    session,
    model: "m",
    maxIterations: 8,
    shellEnabled: true,
    signal: new AbortController().signal,
    cwd: dir,
  });
  const file = path.join(dir, "SUGGESTIONS.md");
  // The write tool ends a file with a newline; the content is what is compared.
  return { result, sent, history, written: fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\n$/, "") : null };
}

test("on ChatGPT the stream's copy is written, whole, and kept as the reply", async () => {
  const { written, history, sent } = await turn([{ content: PAGE, meta: { streamText: RAW } }, DONE]);
  assert.equal(written, DOC.join("\n"));
  assert.equal(sent.length, 2, "no round trip spent on it");
  // The transcript holds what the model wrote, so a replay carries it whole.
  assert.ok(history.some((m) => m.role === "assistant" && m.content === RAW));
});

test("with no stream, the cut file is not written, and the model is told how to send it whole", async () => {
  const FOUR = RAW.replace(/^```onflip/, "````onflip").replace(/```$/, "````");
  const { written, sent } = await turn([PAGE, FOUR, DONE]);
  assert.match(sent[1], /ends inside a code block/);
  assert.match(sent[1], /FOUR backticks/);
  assert.equal(written, DOC.join("\n"), "the resend in four backticks is written whole");
});

test("a file that really ends inside a fence is written when sent again unchanged", async () => {
  // The escape hatch: nothing is lost by asking once, and a file can end
  // inside a code block on purpose.
  const odd = "```onflip\ntool: write\npath: SUGGESTIONS.md\ncontent: |\n  ```text\n  a template left open\n```";
  const { written, sent } = await turn([odd, odd, DONE]);
  assert.match(sent[1], /ends inside a code block/);
  assert.equal(written, "```text\na template left open");
});
