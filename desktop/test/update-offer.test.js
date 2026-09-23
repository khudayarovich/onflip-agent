"use strict";

/**
 * Which release the app offers, and when an offer counts as made.
 *
 * - The check asked GitHub for `/releases/latest`, which is whichever release
 *   came last. This repository publishes the CLI's releases too, so the next
 *   one would have been all the app could see: older than every desktop
 *   version, and no desktop update offered until another desktop release
 *   happened to follow it. Reading the whole list instead made every check
 *   fourteen times larger, and two of them timed out in one afternoon; the
 *   latest is asked first now, and the list only when it is not ours.
 * - "0.10.51-rc.1" split on dots and dashes read as 0.10.51.0.1, newer than
 *   0.10.51, so anyone running a release candidate never got the release.
 * - The timer marked a version announced before delivering it, so a check
 *   that found no window open — the app in the tray — spent the offer on
 *   nobody, beside a log line promising to offer it again later.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const DIST = path.join(__dirname, "..", "dist", "electron");
const needsBuild = fs.existsSync(path.join(DIST, "update-install.js"))
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/** An answer with a status other than 200. */
const http = (status, body) => ({ __http: true, status, body });

/**
 * The compiled updater with `electron` stubbed. `answer` is what GitHub says:
 * the same thing for every request, or `(url, nth) => …` to answer by URL and
 * by how many times that URL has been asked; "network-error" fails the
 * request in transit.
 */
function load(answer, version = "0.10.51") {
  const asked = [];
  const net = {
    request({ url }) {
      asked.push(url);
      const nth = asked.filter((u) => u === url).length;
      const spec = typeof answer === "function" ? answer(url, nth) : answer;
      const request = new EventEmitter();
      request.setHeader = () => {};
      request.abort = () => {};
      request.end = () => {
        if (spec === "network-error") {
          request.emit("error", new Error("net::ERR_CONNECTION_RESET"));
          return;
        }
        const { status, body } = spec && spec.__http ? spec : { status: 200, body: spec };
        const response = new EventEmitter();
        response.statusCode = status;
        request.emit("response", response);
        response.emit("data", Buffer.from(JSON.stringify(body)));
        response.emit("end");
      };
      return request;
    },
  };
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub"] = {
    id: "electron-stub",
    filename: "electron-stub",
    loaded: true,
    exports: { app: { getVersion: () => version, getPath: () => "" }, net },
  };
  try {
    for (const name of ["updates.js", "update-install.js"]) delete require.cache[path.join(DIST, name)];
    return { updates: require(path.join(DIST, "updates.js")), install: require(path.join(DIST, "update-install.js")), asked };
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

const exe = (tag) => ({
  tag_name: tag,
  html_url: `https://github.com/khudayarovich/onflip-agent/releases/tag/${tag}`,
  assets: [
    { name: `OnFlip-Setup-${tag}.exe`, browser_download_url: `https://example.invalid/${tag}.exe` },
    { name: `OnFlip-${tag}-mac-arm64.zip`, browser_download_url: `https://example.invalid/${tag}-arm64.zip` },
    { name: `OnFlip-${tag}-mac-x64.zip`, browser_download_url: `https://example.invalid/${tag}-x64.zip` },
    { name: "SHA256SUMS-windows.txt", browser_download_url: `https://example.invalid/${tag}/win.txt` },
    { name: "SHA256SUMS-macos.txt", browser_download_url: `https://example.invalid/${tag}/mac.txt` },
  ],
});

test("a release candidate comes before its release", { skip: needsBuild }, () => {
  const { isNewer } = load([]).updates;
  assert.equal(isNewer("0.10.51", "0.10.51-rc.1"), true, "the release is offered to someone on the candidate");
  assert.equal(isNewer("0.10.51-rc.1", "0.10.51"), false, "and the candidate is not offered over the release");
  assert.equal(isNewer("0.10.51-rc.2", "0.10.51-rc.1"), true);
  assert.equal(isNewer("0.10.51-rc.10", "0.10.51-rc.9"), true, "numerically");
  assert.equal(isNewer("0.10.51-rc.1", "0.10.51-beta.3"), true, "words compare as words");
  assert.equal(isNewer("0.10.52-rc.1", "0.10.51"), true, "a later candidate is still later");
  // The false-positive half: the ordinary comparisons are unchanged.
  assert.equal(isNewer("0.10.10", "0.10.9"), true);
  assert.equal(isNewer("0.10.51", "0.10.51"), false);
  assert.equal(isNewer("0.9.99", "0.10.0"), false);
});

test("the desktop release is picked out of everything the repository publishes", { skip: needsBuild }, () => {
  const { pickDesktopRelease } = load([]).updates;
  const picked = pickDesktopRelease([
    exe("v0.3.0"), // the CLI, newest of all
    { ...exe("desktop-v0.11.0"), draft: true },
    { ...exe("desktop-v0.10.60-rc.1"), prerelease: true },
    exe("desktop-v0.10.51"),
    exe("desktop-v0.10.52"), // listed out of order
  ]);
  assert.equal(picked.tag_name, "desktop-v0.10.52");
  assert.equal(pickDesktopRelease([exe("v0.3.0")]), undefined, "a page of CLI releases offers nothing");
  assert.equal(pickDesktopRelease({ message: "API rate limit exceeded" }), undefined);
});

const LATEST = /\/releases\/latest$/;
const LIST = /\/releases\?per_page=\d+$/;

test("the check finds the desktop release with one small request", { skip: needsBuild }, async () => {
  // The list is nearly 300 KB against 20 KB for the latest alone, inside the
  // same ten seconds; two checks in one afternoon ran out of them.
  const { updates, asked } = load((url) => (LATEST.test(url) ? exe("desktop-v0.10.52") : []));
  const info = await updates.checkForUpdate();
  assert.equal(asked.length, 1, "one request");
  assert.match(asked[0], LATEST);
  assert.equal(info.latest, "0.10.52");
  assert.equal(info.available, process.platform === "linux" ? true : Boolean(info.installable));
  assert.equal(info.error, undefined);
});

test("and when the latest release is the CLI's, the list decides", { skip: needsBuild }, async () => {
  const { updates, asked } = load((url) =>
    LATEST.test(url) ? exe("v0.3.0") : [exe("v0.3.0"), exe("desktop-v0.10.52"), exe("desktop-v0.10.51")]
  );
  const info = await updates.checkForUpdate();
  assert.equal(asked.length, 2);
  assert.match(asked[0], LATEST);
  assert.match(asked[1], LIST);
  assert.equal(info.latest, "0.10.52");
});

test("a request that fails in transit is tried once more, and only once", { skip: needsBuild }, async () => {
  const recovered = load((url, nth) => (nth === 1 ? "network-error" : exe("desktop-v0.10.52")));
  const info = await recovered.updates.checkForUpdate();
  assert.equal(info.latest, "0.10.52", "the second try found it");
  assert.equal(recovered.asked.length, 2);
  const down = load(() => "network-error");
  const failed = await down.updates.checkForUpdate();
  assert.equal(failed.available, false);
  assert.match(failed.error, /ERR_CONNECTION_RESET/);
  assert.equal(down.asked.length, 2, "one retry, not a loop");
});

test("but an answer GitHub gave on purpose is not asked again", { skip: needsBuild }, async () => {
  const limited = load(() => http(403, { message: "API rate limit exceeded" }));
  const info = await limited.updates.checkForUpdate();
  assert.equal(info.available, false);
  assert.match(info.error, /GitHub answered 403/);
  assert.equal(limited.asked.length, 1, "a rate limit says the same thing twice");
});

test("a check that finds only older releases offers nothing", { skip: needsBuild }, async () => {
  // The false-positive half.
  const { updates } = load((url) => (LATEST.test(url) ? exe("desktop-v0.10.51") : [exe("desktop-v0.10.51")]));
  const info = await updates.checkForUpdate();
  assert.equal(info.available, false);
  const rateLimited = await load({ message: "API rate limit exceeded" }).updates.checkForUpdate();
  assert.equal(rateLimited.available, false);
  assert.match(rateLimited.error, /list of releases/, "an answer that is not a list is a failed check, said so");
});

test("an offer counts once a window has it, not before", { skip: needsBuild }, () => {
  const { install } = load([]);
  install.__resetAnnouncedForTest();
  const info = { current: "0.10.51", latest: "0.10.52", available: true, url: "" };
  let shown = 0;
  assert.equal(install.announce(info, () => false), false, "no window open");
  assert.equal(install.announce(info, () => (shown++, true)), true, "offered again at the next check");
  assert.equal(install.announce(info, () => (shown++, true)), false, "and then not again");
  assert.equal(shown, 1);
  assert.equal(install.announce({ ...info, latest: "0.10.53" }, () => true), true, "a newer one is offered");
  assert.equal(install.announce({ ...info, available: false }, () => assert.fail("nothing to offer")), false);
});

test("the watch tells the timer whether a window took the offer", { skip: needsBuild }, () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
  const watch = main.slice(main.indexOf("startUpdateWatch((info) => {"));
  const body = watch.slice(0, watch.indexOf("\n    });"));
  assert.match(body, /sendTo\(ws, "update-available", info\);\s*return true;/);
  assert.match(body, /will offer again later"\);\s*return false;/);
});
