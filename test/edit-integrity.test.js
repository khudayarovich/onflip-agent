"use strict";

/**
 * A small edit must change what was asked, where it was asked, and nothing
 * else — or refuse. Every case here was reproduced against the built tools
 * before it was fixed, and each one reported success while doing damage:
 *
 *  - `old_string: |` for the end of a function (body, then the closing brace
 *    one level out) was cut at the brace, and every key after it was dropped:
 *    the edit arrived with no `new_string` and deleted the line it was meant
 *    to change.
 *  - A `write` whose content lost its indentation wrote an empty file.
 *  - A value that looked like JSON was decoded: package.json could not be
 *    written at all, and `["src"]` became the text `src`.
 *  - A code block at the end of a value lost its closing fence.
 *  - A whitespace-relaxed match was found on line 2 and applied to the first
 *    substring match on line 1.
 *  - Relaxed edits in CRLF files wrote bare LF lines, and an `old_string`
 *    whose indentation had been dropped entirely was replaced unindented.
 *  - A Windows-1251 file had every Cyrillic byte replaced by U+FFFD.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-integrity-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");

const { parseTurn } = require("../dist/agent/protocol");
const { runTurn } = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");
const { isProbablyBinary } = require("../dist/tools/util");

const known = (name) =>
  ["read", "write", "edit", "multi_edit", "patch", "bash", "grep", "done", "ask_user"].includes(
    String(name).trim().toLowerCase()
  );

const call = (reply) => {
  const parsed = parseTurn(reply, known);
  return { parsed, args: parsed.calls[0]?.arguments };
};

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(HOME, "ws-"));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  const session = createSessionState();
  const tools = createToolRegistry({
    cwd: dir,
    session,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });
  return { dir, session, tools, read: (name) => fs.readFileSync(path.join(dir, name), "utf8") };
}

// --- the block form keeps every byte of every value -------------------------

test("a value that ends shallower than it starts keeps its end, and the keys after it", () => {
  const { parsed, args } = call(
    [
      "```onflip",
      "tool: edit",
      "path: a.js",
      "old_string: |",
      "          return 1;",
      "      }",
      "new_string: |",
      "          return 2;",
      "      }",
      "```",
    ].join("\n")
  );
  assert.equal(parsed.malformed, undefined);
  assert.equal(args.old_string, "    return 1;\n}");
  assert.equal(args.new_string, "    return 2;\n}", "the key after it survives");
});

test("text that looks like JSON is written as text", () => {
  const { args } = call('```onflip\ntool: write\npath: package.json\ncontent: |\n  {"name": "x"}\n```');
  assert.equal(args.content, '{"name": "x"}');
  const edit = call('```onflip\ntool: edit\npath: t.json\nold_string: |\n  ["src"]\nnew_string: |\n  ["src", "test"]\n```');
  assert.equal(edit.args.old_string, '["src"]');
  assert.equal(edit.args.new_string, '["src", "test"]');
});

test("a code block at the end of a value keeps its closing fence", () => {
  const { args } = call(
    ["````onflip", "tool: write", "path: README.md", "content: |", "  # Title", "  ```bash", "  npm ci", "  ```", "````"].join("\n")
  );
  assert.equal(args.content, "# Title\n```bash\nnpm ci\n```");
});

test("a value that lost its indentation is sent back, never written as nothing", () => {
  const { parsed } = call("```onflip\ntool: write\npath: notes.md\ncontent: |\n# Release notes\n- fixed\n```");
  assert.equal(parsed.calls.length, 0, "no write runs");
  assert.match(parsed.malformed, /nothing indented under it/);
});

test("a line that loses its indentation mid-value stops the call instead of dropping what follows", () => {
  const { parsed } = call(
    ["```onflip", "tool: edit", "path: a.js", "old_string: |", "  foo();", "bar();", "new_string: |", "  baz();", "```"].join("\n")
  );
  assert.equal(parsed.calls.length, 0);
  assert.match(parsed.malformed, /not indented under its key/);
});

test("a sentence after a finished call is still just a sentence", () => {
  // The tolerance the stricter rule must not take away: nothing follows it.
  const reply = "tool: bash\ncommand: npm test\nThat runs the suite.";
  const { parsed, args } = call(reply);
  assert.equal(parsed.calls.length, 1);
  assert.equal(args.command, "npm test");
});

test("a tagged call wrapped in its own fence still parses", () => {
  // The fence the old stripping existed for — tags and fence on the same
  // lines — is still taken off, and only because it wraps the whole body.
  const { args } = call('<onflip:tool>```json\n{"tool": "read", "path": "a.txt"}\n```</onflip:tool>');
  assert.equal(args.path, "a.txt");
});

// --- unmarked text is prose -----------------------------------------------------

test("a JSON call shown in prose is an example, not a call", () => {
  const reply = [
    "You can call a tool with JSON, for example:",
    '{"tool": "bash", "command": "Remove-Item -Recurse -Force $HOME\\\\Documents"}',
    "That would delete the folder, so do not run it.",
  ].join("\n");
  assert.equal(parseTurn(reply, known).calls.length, 0);
});

test("where the renderer ate the fence, the JSON is still the call", () => {
  // The live shape the bare-JSON path exists for.
  const reply = 'onflip\n{"tool": "read", "path": "a.txt"}';
  const parsed = parseTurn(reply, known);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].arguments.path, "a.txt");
  assert.equal(parseTurn('{"tool": "read", "path": "a.txt"}', known).calls.length, 1, "and a reply that is only the object");
});

test("an example call inside a value being written does not run", () => {
  const reply = [
    "tool: write",
    "path: docs/a.md",
    "content: |",
    "  Example:",
    "  tool: bash",
    "  command: ./scripts/reset-db.sh",
  ].join("\n");
  const parsed = parseTurn(reply, known);
  assert.deepEqual(parsed.calls.map((c) => c.tool), ["write"]);
  assert.match(parsed.calls[0].arguments.content, /reset-db/);
});

// --- the loop ----------------------------------------------------------------------

function scripted(replies) {
  const sent = [];
  return {
    sent,
    transport: {
      name: "api",
      async send(history, opts) {
        sent.push({ last: history[history.length - 1], reminder: opts.reminder });
        if (!replies.length) throw new Error("the script ran out of replies");
        return { content: replies.shift(), conversationId: null };
      },
      reset() {},
    },
  };
}

const said = (role, content) => ({ id: `${role}-${Math.random()}`, role, content });

test("a word that is only an alias is not a call when it sits in prose", async () => {
  const ws = workspace({ "a.txt": "keep me\n" });
  const { sent, transport } = scripted([
    "Checklist:\nTool: shell\nCommand: git clean -xfd",
    "````onflip\ntool: done\nsummary: |\n  That was a checklist.\n````",
  ]);
  const history = [said("system", "prompt"), said("user", "what would you run?")];
  await runTurn(history, {
    transport,
    tools: ws.tools,
    session: ws.session,
    model: "m",
    maxIterations: 5,
    shellEnabled: true,
    signal: new AbortController().signal,
  });
  assert.ok(!history.some((m) => m.toolName), "nothing ran");
  assert.equal(sent.length, 2, "the prose was nudged, not executed");
});

test("a block that could not be read beside one that could is named to the model", async () => {
  const ws = workspace({ "a.js": "one\ntwo\n" });
  const good = "```onflip\ntool: edit\npath: a.js\nold_string: one\nnew_string: ONE\n```";
  const bad = "```onflip\ntool: edit\npath: a.js\nold_string: |\n  two\nthree\nnew_string: |\n  TWO\n```";
  const { sent, transport } = scripted([
    `${good}\n\n${bad}`,
    "````onflip\ntool: done\nsummary: |\n  Half done.\n````",
  ]);
  await runTurn([said("system", "prompt"), said("user", "change both")], {
    transport,
    tools: ws.tools,
    session: ws.session,
    model: "m",
    maxIterations: 5,
    shellEnabled: false,
    signal: new AbortController().signal,
  });
  assert.equal(ws.read("a.js"), "ONE\ntwo\n", "the good edit ran, the broken one did not");
  assert.match(sent[1].last.content, /could not be read and was NOT run/);
});

// --- the edit tool lands where it says --------------------------------------------

test("a relaxed match changes the line it matched, not an earlier look-alike", async () => {
  const ws = workspace({ "config.py": "max = 10\nx = 1\n" });
  const r = await ws.tools.run("edit", { path: "config.py", old_string: "x = 1 ", new_string: "x = 2" });
  assert.ok(!r.error, r.output);
  assert.equal(ws.read("config.py"), "max = 10\nx = 2\n");

  const batch = workspace({ "config.py": "max = 10\nx = 1\n" });
  await batch.tools.run("multi_edit", { path: "config.py", edits: [{ old_string: "x = 1 ", new_string: "x = 2" }] });
  assert.equal(batch.read("config.py"), "max = 10\nx = 2\n");
});

test("the end of a function keeps its brace where it was", async () => {
  // Exactly what the block form now delivers for the case at the top.
  const ws = workspace({ "a.js": "function f() {\n  if (x) {\n    return 1;\n  }\n}\n" });
  const r = await ws.tools.run("edit", { path: "a.js", old_string: "  return 1;\n}", new_string: "  return 2;\n}" });
  assert.ok(!r.error, r.output);
  assert.equal(ws.read("a.js"), "function f() {\n  if (x) {\n    return 2;\n  }\n}\n");
});

test("an old_string with its indentation dropped is replaced at the file's indentation", async () => {
  const ws = workspace({ "f.py": "def f():\n    x = 1\n    return x\n" });
  await ws.tools.run("edit", { path: "f.py", old_string: "x = 1\nreturn x", new_string: "x = 2\nreturn x" });
  assert.equal(ws.read("f.py"), "def f():\n    x = 2\n    return x\n");
});

test("a relaxed edit in a CRLF file writes CRLF", async () => {
  const ws = workspace({ "a.cs": "class A {\r\n    int x = 1;\r\n    int y = 2;\r\n}\r\n" });
  await ws.tools.run("edit", { path: "a.cs", old_string: "  int x = 1;\n  int y = 2;", new_string: "  int x = 10;\n  int y = 20;" });
  assert.equal(ws.read("a.cs"), "class A {\r\n    int x = 10;\r\n    int y = 20;\r\n}\r\n");
});

test("a file that is not UTF-8 is refused, byte for byte untouched", async () => {
  // "rem Установка" in Windows-1251, then a line the model wants changed.
  const original = Buffer.from("72656d20d3f1f2e0edeee2eae00d0a73657420504f52543d333030300d0a", "hex");
  const ws = workspace({});
  const file = path.join(ws.dir, "setup.bat");
  fs.writeFileSync(file, original);
  for (const [tool, args] of [
    ["edit", { path: "setup.bat", old_string: "PORT=3000", new_string: "PORT=4000" }],
    ["multi_edit", { path: "setup.bat", edits: [{ old_string: "PORT=3000", new_string: "PORT=4000" }] }],
    ["patch", { path: "setup.bat", patch: "@@ -2 +2 @@\n-set PORT=3000\n+set PORT=4000" }],
  ]) {
    const r = await ws.tools.run(tool, args);
    assert.ok(r.error, `${tool} should refuse`);
    assert.match(r.output, /not UTF-8/);
    assert.ok(fs.readFileSync(file).equals(original), `${tool} left the bytes alone`);
  }
});

test("the head of a large UTF-8 file is not mistaken for binary", () => {
  // A two-byte character straddling the 8 KB sample boundary.
  const head = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from("Ж", "utf8")]).subarray(0, 8192);
  assert.equal(isProbablyBinary(head, true), false);
  assert.equal(isProbablyBinary(head), true, "without knowing it is a head, the cut looks like corruption");
});

test("the whole round trip — model text to file — changes only what was asked", async () => {
  const ws = workspace({ "a.js": "function f() {\n    if (x) {\n        return 1;\n    }\n}\n" });
  const reply = [
    "```onflip",
    "tool: edit",
    "path: a.js",
    "old_string: |",
    "          return 1;",
    "      }",
    "new_string: |",
    "          return 2;",
    "      }",
    "```",
  ].join("\n");
  const { calls } = parseTurn(reply, known);
  const r = await ws.tools.run(calls[0].tool, calls[0].arguments);
  assert.ok(!r.error, r.output);
  assert.equal(ws.read("a.js"), "function f() {\n    if (x) {\n        return 2;\n    }\n}\n");
});
