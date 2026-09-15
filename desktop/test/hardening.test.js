"use strict";

/**
 * Two hardening decisions that live in configuration, not in code paths.
 *
 * Both came out of an external audit, and both are the kind of thing that
 * disappears in a merge without anything failing: a build setting and a
 * startup gate. Nothing exercises them at runtime on the machine that
 * builds, so nothing would notice them going.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const VIEW = path.join(__dirname, "..", "electron", "browser-view.ts");

test("the macOS build does not ship Electron's allow-anything transport policy", () => {
  // Electron's stock Info.plist declares arbitrary loads permitted. Most of
  // this app's traffic goes through Chromium's own stack, which does not
  // consult it - so this is a declaration, not a wall, and it is worth
  // saying so rather than overstating it. What it does is stop the shipped
  // bundle claiming a permission it has no need of.
  const ats = PKG.build?.mac?.extendInfo?.NSAppTransportSecurity;

  assert.ok(ats, "mac.extendInfo.NSAppTransportSecurity is missing from the build config");
  assert.equal(ats.NSAllowsArbitraryLoads, false);
  // Local networking stays allowed on purpose: the address bar exists to
  // reach http://localhost:3000, and a dev server is the common case.
  assert.equal(ats.NSAllowsLocalNetworking, true);
});

test("the DevTools port can be closed from Settings, not only by an env var", () => {
  // The port is the Browser pane: it is how the agent's browser tools drive
  // the docked view, and it is unauthenticated because Chromium offers no
  // authentication. It cannot be secured while open, so the only real
  // control is whether it opens - and a control nobody can find is not one.
  const source = fs.readFileSync(VIEW, "utf8");
  const fn = source.slice(source.indexOf("export function enableEmbeddedBrowser"));
  const body = fn.slice(0, fn.indexOf("appendSwitch"));

  assert.match(body, /embeddedBrowserDisabled\(\)/);
  // And the switch is still bound to loopback when it does open.
  assert.match(source, /remote-debugging-address", "127\.0\.0\.1"/);
});

test("turning it off is opt-in: only an explicit false closes the pane", () => {
  // A missing key, a corrupt file, an unreadable home directory - none of
  // those may silently remove a working feature. The read is `=== false`
  // and the catch returns false, and both halves matter.
  const source = fs.readFileSync(VIEW, "utf8");
  const fn = source.slice(source.indexOf("function embeddedBrowserDisabled"));

  assert.match(fn, /raw\.embeddedBrowser === false/);
  assert.match(fn, /catch[\s\S]{0,60}return false;/);
});
