"use strict";

/**
 * Files attached to a ChatGPT message survive a send whose chat is dropped.
 *
 * The queue is spent when a send starts, so a retyped message never uploads
 * twice. A send whose chat was then dropped — never landed, stalled,
 * refused — is replayed into a fresh chat, and the replay carried
 * "[Attached to this message: …]" with no file behind it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { attachmentsAfterFailure } = require("../dist/chatgpt/browser-client");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-requeue-"));
const shot = path.join(dir, "shot.png");
fs.writeFileSync(shot, "png");

test("a dropped chat gets the files back for its replay", () => {
  assert.deepEqual(attachmentsAfterFailure([shot], [], false), [shot]);
});

test("a kept chat does not, and newer files are not overwritten", () => {
  // The false-positive half: the kept chat already holds them, and files
  // queued since belong to the next message.
  assert.deepEqual(attachmentsAfterFailure([shot], [], true), []);
  const newer = path.join(dir, "newer.png");
  assert.deepEqual(attachmentsAfterFailure([shot], [newer], false), [newer]);
  assert.deepEqual(attachmentsAfterFailure([path.join(dir, "gone.png")], [], false), [], "a file deleted since is not re-queued");
});

test("every send goes through the wrapper that puts them back", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chatgpt", "browser-client.ts"), "utf8");
  assert.match(
    source,
    /async function sendOn\([^)]*\): Promise<string> \{\s*const queued = pendingAttachments;\s*try \{\s*return await sendOnce\(p, message, opts\);\s*\} catch \(e\) \{\s*pendingAttachments = attachmentsAfterFailure\(queued, pendingAttachments, inConversation\);/
  );
});
