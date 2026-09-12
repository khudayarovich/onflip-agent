"use strict";

/**
 * What may become a command allowlist key, and what may not.
 *
 * From an external review, confirmed on two live machines. The allowlist
 * only ever grows, so anything junk that gets in stays in and widens the
 * permission surface for the life of the install - and both machines had
 * junk in it, by the same mechanism wearing two disguises:
 *
 *   macOS:   `"`, `"select`, `vnc"`   from a quoted SQL string cut on its
 *                                     own `;`
 *   Windows: `$os`, `$path`, `$magick` from PowerShell assignments cut on
 *                                     newlines
 *
 * Both are the old separator split, which knew nothing about quotes and
 * treated every fragment as a command in its own right.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitCommands,
  commandKeys,
  isStorableCommandKey,
  createPolicy,
  remember,
} = require("../dist/agent/permissions");

test("a separator inside quotes does not split the command", () => {
  // The macOS case, exactly.
  assert.deepEqual(commandKeys('sqlite3 db "select * from x ; select * from vnc"'), ["sqlite3"]);
  assert.deepEqual(commandKeys("grep -r 'a|b' ."), ["grep"]);
  assert.deepEqual(commandKeys('echo "a && b"'), ["echo"]);
});

test("a real separator still splits", () => {
  assert.deepEqual(commandKeys("npm run build && node --test"), ["npm run", "node"]);
  assert.deepEqual(commandKeys("cat x | grep y ; ls"), ["cat", "grep", "ls"]);
  assert.deepEqual(commandKeys("ls\nps"), ["ls", "ps"]);
});

test("an escaped quote inside double quotes does not end the string", () => {
  assert.deepEqual(commandKeys('echo "she said \\"; rm -rf /\\" and left"'), ["echo"]);
});

test("the junk found on real machines can never be stored", () => {
  for (const junk of ['"', '"select', 'vnc"', "$os", "$path", "$magick", "app=", "$(", "`"]) {
    assert.equal(isStorableCommandKey(junk), false, junk);
  }
});

test("shell control words are not commands", () => {
  // Clearing `if` would clear every compound command beginning with one.
  for (const word of ["if", "then", "fi", "for", "while", "do", "done", "select", "in"]) {
    assert.equal(isStorableCommandKey(word), false, word);
  }
});

test("privilege escalation is never remembered", () => {
  for (const word of ["sudo", "su", "doas", "runas"]) {
    assert.equal(isStorableCommandKey(word), false, word);
  }
});

test("real commands are still storable", () => {
  for (const key of [
    "node", "echo", "sqlite3", "get-content", "get-ciminstance",
    "git commit", "npm run", "go version",
    "/usr/bin/python3", "./scripts/build.sh", "c:/tools/x.exe",
  ]) {
    assert.equal(isStorableCommandKey(key), true, key);
  }
});

test("approving a quoted command stores the command, not the quoted text", () => {
  const policy = createPolicy(process.cwd(), "ask");
  remember(policy, { kind: "command", subject: 'sqlite3 db "select * from x ; drop table vnc"' });
  assert.deepEqual([...policy.allowedCommands], ["sqlite3"]);
});

test("approving a PowerShell assignment stores nothing it should not", () => {
  const policy = createPolicy(process.cwd(), "ask");
  remember(policy, { kind: "command", subject: "$os = Get-CimInstance Win32_OperatingSystem\n$p = 1" });
  // `$os` and `$p` are variables, not commands: neither may be stored.
  assert.deepEqual([...policy.allowedCommands], []);
});

test("a stored allowlist is filtered on load, so old junk clears itself", () => {
  // The install heals on the next save, without anyone editing JSON by hand.
  const policy = createPolicy(process.cwd(), "ask", {
    commands: ['"', '"select', 'vnc"', "sudo", "if", "$os", "node", "git commit"],
  });
  assert.deepEqual([...policy.allowedCommands].sort(), ["git commit", "node"]);
});
