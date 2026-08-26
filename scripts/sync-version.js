#!/usr/bin/env node
/**
 * Keep the version the CLI reports in step with package.json.
 *
 * `VERSION` in src/repl.ts is a plain constant rather than an import, because
 * package.json sits outside `rootDir` and pulling it in rearranges the whole
 * dist layout. The cost of that is two places to change, so `npm version` runs
 * this and CI runs it with --check — a release that says 0.2.0 while calling
 * itself 0.1.0 is the kind of thing nobody notices until a bug report.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const target = path.join(root, "src", "repl.ts");
const { version } = require(path.join(root, "package.json"));

const source = fs.readFileSync(target, "utf8");
const pattern = /export const VERSION = "([^"]*)";/;
const found = pattern.exec(source);

if (!found) {
  console.error("sync-version: no VERSION constant in src/repl.ts");
  process.exit(1);
}

if (found[1] === version) {
  if (process.argv.includes("--check")) console.log(`version ${version} is in sync`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  console.error(
    `sync-version: package.json says ${version}, src/repl.ts says ${found[1]}. ` +
      "Run `node scripts/sync-version.js` and commit the result."
  );
  process.exit(1);
}

fs.writeFileSync(target, source.replace(pattern, `export const VERSION = "${version}";`));
console.log(`sync-version: src/repl.ts ${found[1]} -> ${version}`);
