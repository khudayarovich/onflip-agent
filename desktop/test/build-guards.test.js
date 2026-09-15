"use strict";

/**
 * Every desktop test that loads compiled code must be able to sit out.
 *
 * `npm run test:only` is a bare `node --test`, which discovers every
 * `*.test.js` in the repository — including these, from the engine job,
 * which builds `src/` and never builds `desktop/dist`. A test that requires
 * something out of `dist` there dies with MODULE_NOT_FOUND, and one file
 * without a guard turns all six engine jobs red.
 *
 * That is not hypothetical: it is what happened. `approval-toast.test.js`
 * landed on 8 September without a guard and CI was red on every commit for
 * five days — through four releases — while the suite passed on the machine
 * it was written on, because that machine had `desktop/dist` sitting there
 * from running the app. A green local run says nothing about this.
 *
 * So the rule is checked rather than remembered: load from `dist`, carry a
 * `needsBuild` guard, and pass it to every test in the file.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const SELF = path.basename(__filename);

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.js") && name !== SELF);

/** Files that reach into the compiled output, and so need the guard. */
function loadsFromDist(source) {
  return source.includes('"dist"') || source.includes("/dist/");
}

/** The `test("...")` declarations at the top level of a file. */
function declarations(source) {
  return source.split("\n").filter((line) => line.startsWith("test("));
}

test("there are desktop tests to check", () => {
  // A rename that emptied this list would make every assertion below pass
  // vacuously, which is the failure mode this whole file exists to prevent.
  assert.ok(files.length > 5, `found only ${files.length} desktop test files`);
});

test("every test that loads compiled code declares a build guard", () => {
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    if (!loadsFromDist(source)) continue;
    assert.ok(
      source.includes("const needsBuild ="),
      `${name} loads from desktop/dist but has no needsBuild guard — it will ` +
        `fail the engine CI job, which never builds it`
    );
  }
});

test("and passes that guard to every one of its tests", () => {
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    if (!loadsFromDist(source)) continue;
    for (const line of declarations(source)) {
      assert.ok(
        line.includes("skip: needsBuild"),
        `${name}: this test would still run without desktop/dist — ${line.trim()}`
      );
    }
  }
});

/** The `dist/electron/<name>.js` modules a test file loads. */
function electronModulesLoadedBy(source) {
  const names = [];
  for (const m of source.matchAll(/["']electron["']\s*,\s*["']([\w.-]+)\.js["']/g)) names.push(m[1]);
  for (const m of source.matchAll(/dist\/electron\/([\w.-]+)\.js/g)) names.push(m[1]);
  return [...new Set(names)];
}

test("every test that loads a compiled Electron module stubs Electron", () => {
  // CI installs with `--ignore-scripts`, so Electron's binary is never
  // downloaded and `require("electron")` throws "Electron failed to install
  // correctly". A test that loads something from `dist/electron` which
  // imports Electron, without replacing that import, therefore passes on a
  // developer machine - where the app has been run - and fails on every CI
  // machine.
  //
  // Not hypothetical: update-verify.test.js landed without a stub and the
  // desktop job was red for six releases while the suite passed locally
  // every time. Exactly the `needsBuild` lesson above, one dependency
  // further out, so it is checked rather than remembered.
  //
  // The question is asked of the module's own source rather than of the
  // path: plenty of things under `electron/` are pure, and demanding a stub
  // for those would be a rule people learn to work around.
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    const needsStub = electronModulesLoadedBy(source).filter((mod) => {
      const src = path.join(__dirname, "..", "electron", `${mod}.ts`);
      return fs.existsSync(src) && /from ["']electron["']/.test(fs.readFileSync(src, "utf8"));
    });
    if (!needsStub.length) continue;
    assert.ok(
      source.includes("_resolveFilename"),
      `${name} loads ${needsStub.join(", ")} from dist/electron, which import ` +
        `Electron, but does not stub it - it will throw "Electron failed to ` +
        `install correctly" on CI, where node_modules is installed with ` +
        `--ignore-scripts`
    );
  }
});
