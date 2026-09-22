"use strict";

/**
 * The approval toast's XML and the URL its buttons answer through.
 *
 * The URL round-trip is the part that must never drift: the XML carries what
 * `approvalDecisionUrl` builds, `second-instance` hands back whatever Windows
 * launched, and `parseApprovalUrl` must read its own writing exactly — a
 * mismatch is a button that brings the app forward instead of answering.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "electron", "approval-toast.js");
// The engine's CI job builds src/ and not the desktop app, and the root
// runner discovers every *.test.js in the repository - so this file has to
// be able to sit out rather than fail. It runs locally and in the desktop
// job, which does build it.
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const load = () => require(DIST);

test("decision URLs round-trip through the parser", { skip: needsBuild }, () => {
  const { approvalDecisionUrl, parseApprovalUrl } = load();
  for (const allow of [true, false]) {
    const url = approvalDecisionUrl("ab12cd34", 17, allow);
    assert.deepEqual(parseApprovalUrl(url), { nonce: "ab12cd34", id: 17, allow });
  }
});

test("anything that is not a decision URL parses to null", { skip: needsBuild }, () => {
  const { parseApprovalUrl } = load();
  for (const url of [
    "onflip://focus",
    "onflip://approval/",
    "onflip://approval/nonce/12",
    "onflip://approval/nonce/12/maybe",
    "onflip://approval/nonce/notanumber/allow",
    "https://example.com/onflip://approval/n/1/allow",
    "",
  ]) {
    assert.equal(parseApprovalUrl(url), null, url);
  }
});

test("the XML carries both buttons and escapes what the engine sent", { skip: needsBuild }, () => {
  const { approvalToastXml } = load();
  const xml = approvalToastXml({
    title: "OnFlip needs your approval",
    body: 'bash: git commit -m "<done> & dusted"',
    lang: "en",
    nonce: "n0",
    id: 3,
  });
  assert.match(xml, /content="Allow once"[^>]*arguments="onflip:\/\/approval\/n0\/3\/allow"/);
  assert.match(xml, /content="Deny"[^>]*arguments="onflip:\/\/approval\/n0\/3\/deny"/);
  assert.match(xml, /launch="onflip:\/\/focus"/);
  // The raw body must not survive unescaped — it would break the XML.
  assert.ok(!xml.includes('"<done> & dusted"'));
  assert.ok(xml.includes("&quot;&lt;done&gt; &amp; dusted&quot;"));
});

test("every language the app speaks has its button labels", { skip: needsBuild }, () => {
  const { APPROVAL_TOAST_STRINGS, approvalToastXml } = load();
  for (const lang of ["en", "ru", "uz"]) {
    assert.ok(APPROVAL_TOAST_STRINGS[lang], lang);
    const xml = approvalToastXml({ title: "t", body: "b", lang, nonce: "n", id: 1 });
    assert.ok(xml.includes(`content="${APPROVAL_TOAST_STRINGS[lang].allow}"`), lang);
    assert.ok(xml.includes(`content="${APPROVAL_TOAST_STRINGS[lang].deny}"`), lang);
  }
  // An unknown language falls back to English rather than empty buttons.
  const fallback = approvalToastXml({ title: "t", body: "b", lang: "fr", nonce: "n", id: 1 });
  assert.ok(fallback.includes('content="Allow once"'));
});

test("a malformed decision URL is not a decision, and does not throw", { skip: needsBuild }, () => {
  // Any local process, or a web page once the browser's "Open OnFlip?" is
  // accepted, can launch the app with a URL; `%` alone made
  // decodeURIComponent throw in the main process's second-instance handler.
  const { parseApprovalUrl } = load();
  assert.equal(parseApprovalUrl("onflip://approval/%/1/allow"), null);
  assert.equal(parseApprovalUrl("onflip://approval/%E0%A4%A/2/deny"), null);
});
