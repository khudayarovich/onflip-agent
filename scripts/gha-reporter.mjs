// A node:test reporter that turns every failing test into a GitHub Actions
// error annotation.
//
// A job's log can only be downloaded with admin rights on the repository;
// its annotations are public, on the run's summary page and through the
// API. Without this, a red run said "Process completed with exit code 1"
// and nothing else — the Windows and macOS engine jobs failed for a day on
// a path compared as a string, and the reason could not be read from
// anywhere but a machine that could reproduce it.
//
// Used beside the spec reporter in ci.yml, never instead of it.

import path from "node:path";

const escape = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    // A suite or file that failed because a test inside it did is already
    // reported by that test.
    if (error?.failureType === "subtestsFailed") continue;
    const cause = error?.cause ?? error;
    const message = String(cause?.message ?? cause ?? "failed")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(" | ");
    const local = file && file.startsWith("file:") ? new URL(file).pathname : file;
    const where = local
      ? ` file=${escape(path.relative(process.cwd(), local).replace(/\\/g, "/"))}` + (line ? `,line=${line}` : "")
      : "";
    yield `::error${where}::${escape(`${name}: ${message}`.slice(0, 900))}\n`;
  }
}
