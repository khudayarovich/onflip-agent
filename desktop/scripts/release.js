/**
 * Build the Windows installer.
 *
 * In development `node_modules/onflip` is a symlink to the repository root,
 * which electron-builder must never follow: the root contains this very app
 * (a copy loop), its .git, and its sources. So for packaging the link is
 * replaced with a real, minimal copy of the package — dist/ plus its
 * production dependency closure, copied from the root's node_modules so the
 * already-built better-sqlite3 binding comes along (npm would skip its
 * install script and leave it broken). The symlink is restored afterwards.
 *
 * Steps: compile → materialise onflip → electron-builder → restore.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP = path.join(__dirname, "..");
const ROOT = path.join(DESKTOP, "..");
const LINK = path.join(DESKTOP, "node_modules", "onflip");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { cwd: DESKTOP, stdio: "inherit" });
}

/** Production dependency closure of the core, resolved in the root tree. */
function dependencyClosure() {
  const seen = new Set();
  const queue = Object.keys(readPkg(ROOT).dependencies ?? {});
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = path.join(ROOT, "node_modules", name);
    if (!fs.existsSync(dir)) continue; // optional dep for another platform
    seen.add(name);
    const pkg = readPkg(dir);
    queue.push(
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {})
    );
  }
  return [...seen];
}

function readPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

function materialise() {
  const stat = fs.lstatSync(LINK, { throwIfNoEntry: false });
  if (!stat) throw new Error("node_modules/onflip is missing — run npm install first.");
  if (!stat.isSymbolicLink()) {
    console.log("node_modules/onflip is already a real directory — reusing it.");
    return;
  }
  fs.rmSync(LINK, { recursive: false, force: true });
  fs.mkdirSync(LINK, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(LINK, "package.json"));
  fs.cpSync(path.join(ROOT, "dist"), path.join(LINK, "dist"), { recursive: true });

  const packages = dependencyClosure();
  console.log(`vendoring ${packages.length} packages from the root tree…`);
  for (const name of packages) {
    fs.cpSync(
      path.join(ROOT, "node_modules", name),
      path.join(LINK, "node_modules", name),
      { recursive: true, dereference: true }
    );
  }
}

function restore() {
  try {
    fs.rmSync(LINK, { recursive: true, force: true });
    run("npm install --no-audit --no-fund");
  } catch (e) {
    console.error(
      `Could not restore the onflip symlink automatically (${e.message}). Run: npm install`
    );
  }
}

function main() {
  // --mac builds the macOS artifacts; it only produces working apps when run
  // ON macOS (the .app carries symlinks and dmg needs hdiutil), which is why
  // CI runs it on a macos runner rather than this ever running on Windows.
  const mac = process.argv.includes("--mac");
  run("npx tsc -p tsconfig.json");
  run("npx vite build");
  materialise();
  try {
    run(mac ? "npx electron-builder --mac --arm64 --x64" : "npx electron-builder --win --x64");
  } finally {
    restore();
  }
  console.log(`\nInstaller written to ${path.join(DESKTOP, "release")}`);
}

main();
