"use strict";

/**
 * A background job is found by the id the model gave, however it spelled
 * the argument.
 *
 * Live, on a Mac: `kill_job` with `job_id: job_1`. The tool read only `id`,
 * answered `No job with id ""`, and the model concluded the tool was broken
 * and left the old server running beside the new one it had just started.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bashTool, jobOutputTool, killJobTool } = require("../dist/tools/shell");

const windows = process.platform === "win32";

test("kill_job and job_output take the id under the names models use", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-job-id-"));
  const ctx = { cwd: dir, signal: new AbortController().signal, requestPermission: async () => ({ allow: true }) };
  const started = await bashTool.run(
    { command: windows ? "Start-Sleep -Seconds 30" : "sleep 30", background: true, description: "test" },
    ctx
  );
  const id = /as (job_\d+)/.exec(started.output)?.[1];
  assert.ok(id, started.output);
  try {
    const read = await jobOutputTool.run({ job_id: id }, ctx);
    assert.equal(read.error, undefined, read.output);
    const stopped = await killJobTool.run({ job_id: id }, ctx);
    assert.equal(stopped.error, undefined, stopped.output);
  } finally {
    await killJobTool.run({ id }, ctx);
  }
});

test("a call that names no job is told which argument it is", async () => {
  const none = await killJobTool.run({}, {});
  assert.equal(none.error, true);
  assert.match(none.output, /No job id was given: pass it as `id`/);
  const wrong = await jobOutputTool.run({ id: "job_999" }, {});
  assert.match(wrong.output, /No job with id "job_999"/);
});
