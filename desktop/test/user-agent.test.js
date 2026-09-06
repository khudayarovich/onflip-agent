"use strict";

/**
 * How the agent's browser introduces itself.
 *
 * Electron advertises itself twice in every request — once as the app,
 * once as the runtime — and to a bot check those are the two most
 * conspicuous tokens a request can carry. Reported live: Cloudflare
 * challenging page after page, the same verification over and over, on a
 * browser a person was sitting in front of and driving by hand.
 *
 * Everything else already looked like a real browser. It was the name badge.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "browser-view.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/** The module imports Electron at the top; only pure exports are used here. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-ua";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-ua"] = {
    id: "electron-stub-ua",
    filename: "electron-stub-ua",
    loaded: true,
    exports: {
      app: { commandLine: { appendSwitch() {} }, getPath: () => "", userAgentFallback: "" },
      BrowserWindow: class {},
      WebContentsView: class {},
    },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

// Exactly what this machine reported, before the fix.
const ELECTRON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "onflip-desktop/0.8.9 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";

test("the two giveaway tokens are gone", { skip: needsBuild }, () => {
  const { chromeUserAgent } = load();
  const ua = chromeUserAgent(ELECTRON_UA);

  assert.doesNotMatch(ua, /electron/i);
  assert.doesNotMatch(ua, /onflip/i);
});

test("what is left is a plain Chrome user agent", { skip: needsBuild }, () => {
  const { chromeUserAgent } = load();

  assert.equal(
    chromeUserAgent(ELECTRON_UA),
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/130.0.6723.191 Safari/537.36"
  );
});

test("the Chrome version is kept, not rewritten", { skip: needsBuild }, () => {
  // A hard-coded version drifts at the next Electron bump and then claims a
  // Chrome that does not match the engine's own behaviour — a worse signal
  // than the one being removed.
  const { chromeUserAgent, chromeMajor } = load();
  const ua = chromeUserAgent(ELECTRON_UA);

  assert.match(ua, /Chrome\/130\.0\.6723\.191/);
  assert.equal(chromeMajor(ua), "130");
});

test("a future Electron is handled the same way", { skip: needsBuild }, () => {
  const { chromeUserAgent, chromeMajor } = load();
  const future =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "onflip-desktop/1.2.3 Chrome/141.0.1.2 Electron/40.0.0 Safari/537.36";
  const ua = chromeUserAgent(future);

  assert.doesNotMatch(ua, /electron|onflip/i);
  assert.match(ua, /Chrome\/141\.0\.1\.2/);
  assert.equal(chromeMajor(ua), "141");
});

test("a user agent with nothing to remove is left alone", { skip: needsBuild }, () => {
  const { chromeUserAgent } = load();
  const real =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/130.0.6723.191 Safari/537.36";

  assert.equal(chromeUserAgent(real), real);
});

test("no double spaces are left where a token was cut out", { skip: needsBuild }, () => {
  const { chromeUserAgent } = load();

  assert.doesNotMatch(chromeUserAgent(ELECTRON_UA), /\s{2,}/);
});

test("a user agent without a Chrome token yields no version", { skip: needsBuild }, () => {
  // The client-hint rewrite is skipped in that case rather than guessing.
  const { chromeMajor } = load();

  assert.equal(chromeMajor("Mozilla/5.0 (X11; Linux x86_64)"), "");
});

// --- where the client hints belong -----------------------------------------

test("client hints go to secure origins, the way Chrome sends them", { skip: needsBuild }, () => {
  const { isSecure } = load();

  assert.equal(isSecure("https://example.com/x"), true);
  assert.equal(isSecure("wss://example.com/socket"), true);
});

test("loopback counts as secure, however it is spelled", { skip: needsBuild }, () => {
  // Chromium treats loopback as potentially trustworthy, so Chrome does send
  // hints to a local dev server — the commonest thing the agent browses.
  const { isSecure } = load();

  assert.equal(isSecure("http://localhost:5173/"), true);
  assert.equal(isSecure("http://127.0.0.1:8000/app"), true);
});

test("a plain-http site gets none, because Chrome sends none", { skip: needsBuild }, () => {
  // Adding them there would be the anomaly rather than the fix.
  const { isSecure } = load();

  assert.equal(isSecure("http://example.com/"), false);
  assert.equal(isSecure("file:///C:/tmp/page.html"), false);
  assert.equal(isSecure("not a url at all"), false);
});

test("the platform hint names this machine", { skip: needsBuild }, () => {
  const { platformHint } = load();
  const expected = { win32: "Windows", darwin: "macOS" }[process.platform] ?? "Linux";

  assert.equal(platformHint(), expected);
});

// --- what the brands may claim ---------------------------------------------

test("the hints name Google Chrome, and so does the JavaScript", { skip: needsBuild }, () => {
  // This assertion has been both ways round, and each way was half right.
  //
  // Claiming Chrome in the header while `navigator.userAgentData` still said
  // Chromium was the contradiction Cloudflare looks for. Saying Chromium in
  // both was consistent and Google refused it outright — measured against
  // Google's own endpoint, same session, back to back: Chromium landed on
  // `/signin/rejected` with no login form, Google Chrome landed on
  // `/signin/identifier` with the form present.
  //
  // They were only in conflict while the two were set separately.
  // `installChromeBrands` puts the same list into the page, so the header can
  // say Chrome without lying about what the JavaScript will report.
  const { brandHeader } = load();
  const header = brandHeader("130");

  assert.match(header, /"Google Chrome";v="130"/);
  assert.match(header, /"Chromium";v="130"/);
  // The GREASE entry every Chrome sends; its absence is its own signal.
  assert.match(header, /Not\?A_Brand/);
});

test("the version in the hints is the one in the user agent", { skip: needsBuild }, () => {
  // A header naming one Chrome and a UA naming another is the same
  // self-contradiction, in a smaller place.
  const { brandHeader, chromeMajor, chromeUserAgent } = load();
  const ua = chromeUserAgent(ELECTRON_UA);
  const major = chromeMajor(ua);

  assert.equal(major, "130");
  assert.match(brandHeader(major), new RegExp(`"Google Chrome";v="${major}"`));
  assert.match(brandHeader(major), new RegExp(`"Chromium";v="${major}"`));
});

// --- when a provider refuses the window -------------------------------------

test("Google's refusal pages are recognised, ordinary ones are not", { skip: needsBuild }, () => {
  // Four fingerprint fixes went into this window — the user agent, the brand
  // list, navigator.webdriver, an empty window.chrome — and each corrected a
  // real tell without changing Google's answer, because the refusal is
  // decided server-side at the OAuth consent step. So the panel stops trying
  // to look acceptable and says what will work instead; this is what decides
  // when to say it.
  const { isSignInRefusal } = load();

  assert.equal(isSignInRefusal("https://accounts.google.com/v3/signin/rejected?app_domain=x"), true);
  assert.equal(isSignInRefusal("https://accounts.google.com/signin/rejected?disallowed_useragent=1"), true);
  assert.equal(isSignInRefusal("https://accounts.google.com/x/deniedsigninrejected"), true);

  // The step before the refusal is a working login form, not a dead end.
  assert.equal(isSignInRefusal("https://accounts.google.com/v3/signin/identifier"), false);
  assert.equal(isSignInRefusal("https://chat.deepseek.com/sign_in"), false);
  assert.equal(isSignInRefusal("https://example.com/"), false);
});
