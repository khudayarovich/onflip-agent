"use strict";

/**
 * The brand list a window shows the web.
 *
 * Two checks read it and, until they were set from one place, wanted opposite
 * things. Cloudflare compares the `Sec-CH-UA` header against
 * `navigator.userAgentData` and objects when they differ. Google compares the
 * brands against its idea of a supported browser and refuses OAuth when the
 * answer is only "Chromium" — the "browser or app may not be secure" page
 * that ends a sign-in with Google, reported from the field and reproduced
 * here against Google's own endpoint.
 *
 * Both are satisfied by one list that says Google Chrome and is used for the
 * header and the page alike.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "chrome-brands.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";
const load = () => require(DIST);

// Exactly what Chromium 130 reports inside Electron, measured.
const REAL = [
  { brand: "Not?A_Brand", version: "99" },
  { brand: "Chromium", version: "130" },
];

test("Google Chrome is added at Chromium's own version", { skip: needsBuild }, () => {
  const { withGoogleChrome } = load();
  const out = withGoogleChrome(REAL);

  const chrome = out.find((b) => b.brand === "Google Chrome");
  assert.ok(chrome, "a Google Chrome entry should be present");
  assert.equal(chrome.version, "130", "it must match Chromium's version, not a guess");
});

test("it sits immediately before Chromium, where real Chrome puts it", { skip: needsBuild }, () => {
  const { withGoogleChrome } = load();
  const names = withGoogleChrome(REAL).map((b) => b.brand);
  assert.deepEqual(names, ["Not?A_Brand", "Google Chrome", "Chromium"]);
});

test("the GREASE entry is left exactly as Chromium wrote it", { skip: needsBuild }, () => {
  // Chrome varies this deliberately to keep parsers honest. Normalising it
  // would itself be the thing that stands out.
  const { withGoogleChrome } = load();
  const grease = withGoogleChrome(REAL).find((b) => b.brand === "Not?A_Brand");
  assert.equal(grease.version, "99");
});

test("a list that already names Chrome is untouched", { skip: needsBuild }, () => {
  const { withGoogleChrome } = load();
  const already = [{ brand: "Google Chrome", version: "130" }, { brand: "Chromium", version: "130" }];
  assert.equal(withGoogleChrome(already), already);
});

test("with no Chromium entry, nothing is invented", { skip: needsBuild }, () => {
  // There would be no version to give it, and a wrong version is a worse
  // signal than a missing brand.
  const { withGoogleChrome } = load();
  const odd = [{ brand: "Not?A_Brand", version: "99" }];
  assert.deepEqual(withGoogleChrome(odd), odd);
  assert.deepEqual(withGoogleChrome([]), []);
});

test("a header round-trips through parse and render", { skip: needsBuild }, () => {
  // The sign-in window reads Chromium's own header, adds the brand and writes
  // it back, so both directions have to agree.
  const { parseBrands, renderBrands } = load();
  const header = '"Not?A_Brand";v="99", "Google Chrome";v="130", "Chromium";v="130"';
  assert.equal(renderBrands(parseBrands(header)), header);
});

test("an entry that cannot be parsed is dropped, not thrown over", { skip: needsBuild }, () => {
  // The alternative to a slightly short list is no header at all, and a
  // missing header is the louder signal.
  const { parseBrands } = load();
  const out = parseBrands('"Chromium";v="130", garbage, "Not?A_Brand";v="99"');
  assert.deepEqual(out.map((b) => b.brand), ["Chromium", "Not?A_Brand"]);
});

test("the fallback list is used only when Chromium's could not be read", { skip: needsBuild }, () => {
  const { fallbackBrands, renderBrands } = load();
  assert.match(renderBrands(fallbackBrands("130")), /"Google Chrome";v="130"/);
  // No major version means no honest list to build.
  assert.deepEqual(fallbackBrands(""), []);
});

test("the whole point: header text equals what the page will report", { skip: needsBuild }, () => {
  const { withGoogleChrome, renderBrands, parseBrands } = load();
  const brands = withGoogleChrome(REAL);
  const header = renderBrands(brands);

  assert.deepEqual(parseBrands(header), brands);
  assert.ok(header.includes("Google Chrome"), "Google's check");
});
