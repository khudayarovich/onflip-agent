"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DIST = path.join(__dirname, "..", "dist", "electron", "app-identity.js");
const needsBuild = fs.existsSync(DIST) ? false : "desktop/dist is not built (run: cd desktop && npm run build:node)";

test("the installed taskbar entry names OnFlip and relaunches its own executable", { skip: needsBuild }, () => {
  const { windowAppDetails } = require(DIST);
  const executable = "C:\\Users\\Alex Morgan\\AppData\\Local\\Programs\\OnFlip\\OnFlip.exe";
  const appPath = "C:\\Users\\Alex Morgan\\AppData\\Local\\Programs\\OnFlip\\resources\\app";
  const details = windowAppDetails(executable, appPath, true);
  assert.equal(details.appId, "com.onflip.desktop");
  assert.equal(details.relaunchDisplayName, "OnFlip");
  assert.equal(details.appIconPath, path.join(appPath, "buildResources", "icon.ico"));
  assert.equal(details.appIconIndex, 0);
  assert.equal(details.relaunchCommand, `"${executable}"`);
});

test("a dev taskbar relaunch includes the app folder so Electron opens OnFlip", { skip: needsBuild }, () => {
  const { windowAppDetails } = require(DIST);
  const executable = "C:\\work space\\desktop\\node_modules\\electron\\dist\\electron.exe";
  const appPath = "C:\\work space\\desktop";
  const details = windowAppDetails(executable, appPath, false);
  assert.equal(details.relaunchDisplayName, "OnFlip");
  assert.equal(details.relaunchCommand, `"${executable}" "${appPath}"`);
});
