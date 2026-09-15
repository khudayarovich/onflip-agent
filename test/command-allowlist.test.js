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
  // The keys are whole commands now — an implicit grant is exact — so these
  // assert what they always meant: the quoted separator did not split it.
  assert.deepEqual(commandKeys('sqlite3 db "select * from x ; select * from vnc"'), [
    'sqlite3 db "select * from x ; select * from vnc"',
  ]);
  assert.deepEqual(commandKeys("grep -r 'a|b' ."), ["grep -r 'a|b' ."]);
  assert.deepEqual(commandKeys('echo "a && b"'), ['echo "a && b"']);
});

test("a real separator still splits", () => {
  assert.deepEqual(commandKeys("npm run build && node --test"), ["npm run build", "node --test"]);
  assert.deepEqual(commandKeys("cat x | grep y ; ls"), ["cat x", "grep y", "ls"]);
  assert.deepEqual(commandKeys("ls\nps"), ["ls", "ps"]);
});

test("an escaped quote inside double quotes does not end the string", () => {
  assert.deepEqual(commandKeys('echo "she said \\"; rm -rf /\\" and left"'), [
    'echo "she said \\"; rm -rf /\\" and left"',
  ]);
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
  // The whole command, because an implicit grant is exact now — approving
  // this one must not also approve `sqlite3` doing anything else later.
  assert.deepEqual(
    [...policy.allowedCommands],
    ['sqlite3 db "select * from x ; drop table vnc"']
  );
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

test("a here-document body is not a list of commands", () => {
  // Reported from a live install: the allowlist had grown to 112 entries
  // holding prose - `five`, `each`, `appreciated.`, `0.10.10` - because a bug
  // report had been written to disk with `cat > report.md <<'EOF'` and every
  // line of it was read as a command that had just been approved.
  const q = String.fromCharCode(39);
  const cmd = [
    `cat > report.md <<${q}EOF${q}`,
    "Five findings, each with the exact file.",
    "0.10.10 appreciated. sha256sums alongside",
    "NEVER_REMEMBER covers sudo",
    "EOF",
    "echo done",
  ].join("\n");
  // The body is still skipped, which is what this test is for. The keys are
  // whole commands now, so what would be remembered is this exact redirect
  // into this exact file — not `cat`, which used to mean every later `cat`.
  assert.deepEqual(commandKeys(cmd), ["cat > report.md <<'EOF'", "echo done"]);
});

test("the validator could not have caught it, which is why the body is skipped", () => {
  // Every one of these is a plausible command name. There is no rule that
  // separates them from `node` or `grep`, so the body must not be parsed.
  for (const word of ["five", "each", "sha256sums", "alongside", "never_remember"]) {
    assert.equal(isStorableCommandKey(word), true, word);
  }
});

test("an unquoted and an indented here-doc are both skipped", () => {
  assert.deepEqual(commandKeys("cat <<EOF\nrm -rf /\nEOF\nls"), ["cat <<EOF", "ls"]);
  assert.deepEqual(commandKeys("cat <<-END\n\tsudo su\n\tEND\nls"), ["cat <<-END", "ls"]);
});

test("two here-docs on one line consume two bodies in order", () => {
  const cmd = ["diff <<A <<B", "first body", "A", "second body", "B", "echo after"].join("\n");
  assert.deepEqual(commandKeys(cmd), ["diff <<A <<B", "echo after"]);
});

test("a here-doc that is never terminated does not leak its tail", () => {
  // A truncated command must not start handing out keys from whatever
  // follows it.
  assert.deepEqual(commandKeys("cat <<EOF\nstray line\nanother"), ["cat <<EOF"]);
});

test("a here-string is not a here-doc", () => {
  // `<<<` feeds one word, and the line after it is an ordinary command.
  assert.deepEqual(commandKeys("grep x <<<'text'\nls"), ["grep x <<<'text'", "ls"]);
});

test("approving a command does not approve a different one with the same name", () => {
  // The audit's demonstration, against the shipped build: an `ask` policy
  // holding the remembered key `python` let `python -c "..."` run with no
  // prompt, because the key was the first token and everything after it was
  // discarded. The same held for `npm`, `git`, every shell interpreter, and
  // every command whose arguments are its behaviour.
  //
  // The button said "Always allow python", which described that grant
  // accurately — and the accuracy is what made it invisible. Nobody reads it
  // as "and anything else I ever run through Python".
  const { evaluate } = require("../dist/agent/permissions");
  const policy = createPolicy(process.cwd(), "ask");
  remember(policy, { kind: "command", subject: "python scripts/build.py" });

  // The command that was approved runs again without asking.
  assert.equal(
    evaluate(policy, { kind: "command", subject: "python scripts/build.py" }).outcome,
    "allow"
  );
  // Anything else through the same interpreter does not.
  for (const other of [
    'python -c "import os; os.system(\'rm -rf .\')"',
    "python scripts/deploy.py",
    "python",
  ]) {
    assert.equal(evaluate(policy, { kind: "command", subject: other }).outcome, "ask", other);
  }
});

test("spacing is not a different command", () => {
  // The one thing folded, because two commands differing only in whitespace
  // are the same command and prompting twice for them is noise.
  const { evaluate } = require("../dist/agent/permissions");
  const policy = createPolicy(process.cwd(), "ask");
  remember(policy, { kind: "command", subject: "npm run build" });
  assert.equal(evaluate(policy, { kind: "command", subject: "npm  run   build" }).outcome, "allow");
  assert.equal(evaluate(policy, { kind: "command", subject: " npm run build " }).outcome, "allow");
});

test("a command whose text is decided when it runs is never remembered", () => {
  // Substitution is different in kind from quoting: `$(…)` and backticks are
  // a command whose text is chosen at run time, so an exact match gives no
  // protection — the same stored string is not the same work twice.
  assert.equal(isStorableCommandKey("echo $(whoami)"), false);
  assert.equal(isStorableCommandKey("echo `whoami`"), false);
  // Quoting is fine, because the match is exact and splitCommands has already
  // honoured it: the `;` here is text inside a string, not a second command.
  assert.equal(isStorableCommandKey('sqlite3 db "select * from x ; drop table y"'), true);
});
