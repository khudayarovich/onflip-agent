"use strict";

/**
 * A write that leaves the workspace through a link.
 *
 * From an external security audit: the workspace check resolved a path
 * lexically — `path.resolve` cancels `..` and joins, and knows nothing about
 * symlinks — while the write itself used `fs.writeFileSync`, which follows
 * them. So `workspace/linked/file` looked contained whatever `linked` pointed
 * at, the policy cleared it as a workspace edit under auto-edit or full-auto,
 * and the bytes landed outside. The approval dialog showed the lexical path,
 * which concealed the real target.
 *
 * A repository containing one symlink is enough, which makes this reachable
 * by anything the agent is asked to work on.
 *
 * Both sides of the comparison are canonicalised, and that second half
 * matters as much as the first: on macOS `/tmp` is itself a link to
 * `/private/tmp`, so resolving only the target would put every ordinary
 * workspace write outside its own workspace.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { realPath, createPolicy, evaluate } = require("../dist/agent/permissions");

/** Symlinks need elevation or developer mode on Windows; skip if refused. */
function linkOrSkip(target, link) {
  try {
    fs.symlinkSync(target, link, "junction");
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link);
      return true;
    } catch {
      return false;
    }
  }
}

test("a write through a linked directory is seen for where it lands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-link-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);

  const link = path.join(workspace, "linked");
  if (!linkOrSkip(outside, link)) {
    // Not a pass disguised as a skip: without a link there is nothing here to
    // test, and saying so is better than asserting something else.
    console.log("    (skipped: this system would not create a symlink)");
    return;
  }

  const target = path.join(link, "escaped.txt");

  // The lexical answer, which is what the old check used.
  assert.ok(
    !path.relative(workspace, path.resolve(target)).startsWith(".."),
    "lexically it looks contained, which is the bug"
  );

  // The real answer.
  assert.ok(
    path.relative(realPath(workspace), realPath(target)).startsWith(".."),
    "it really lands outside the workspace"
  );

  // And the policy agrees: auto-edit must not wave this through.
  const policy = createPolicy(workspace, "auto-edit");
  const verdict = evaluate(policy, {
    kind: "write",
    tool: "write_file",
    subject: target,
    targetPath: target,
  });
  assert.equal(verdict.outcome, "ask", "an external write always needs approval");

  fs.rmSync(root, { recursive: true, force: true });
});

test("an ordinary workspace write is still allowed", () => {
  // The other half. A workspace that is itself reached through a link — every
  // macOS temporary directory is — must not have its own writes called
  // external, or this fix would break writing altogether.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-link-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const target = path.join(workspace, "sub", "file.txt");

  const policy = createPolicy(workspace, "auto-edit");
  const verdict = evaluate(policy, {
    kind: "write",
    tool: "write_file",
    subject: target,
    targetPath: target,
  });
  assert.equal(verdict.outcome, "allow", verdict.reason);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a file that does not exist resolves through its nearest real parent", () => {
  // A new file cannot be resolved, and the link on the way is always a
  // directory, so the nearest existing ancestor is the part worth resolving.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-link-"));
  const deep = path.join(root, "a", "b", "c", "not-created-yet.txt");
  const resolved = realPath(deep);
  assert.ok(resolved.endsWith("not-created-yet.txt"), resolved);
  assert.ok(resolved.startsWith(realPath(root)), resolved);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a path with no existing ancestor at all still answers", () => {
  // Never throws: a resolver that can fail becomes a write that skips the
  // check.
  const made = realPath(path.join(os.tmpdir(), "onflip-nothing-here", "x", "y.txt"));
  assert.ok(path.isAbsolute(made), made);
});
