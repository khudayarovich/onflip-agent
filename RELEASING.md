# Releasing

A release is the desktop app: a Windows installer built locally and macOS
disk images built by GitHub Actions, both attached to one GitHub Release.

Desktop releases are tagged `desktop-vX.Y.Z`.

## 1. Version and tag

```bash
cd desktop
# bump "version" in package.json and package-lock.json to X.Y.Z
cd ..
git commit -am "OnFlip Desktop X.Y.Z"
git push origin main
git tag desktop-vX.Y.Z
git push origin desktop-vX.Y.Z
```

## 2. Build the Windows installer

```bash
cd desktop
npm run installer
```

`scripts/release.js` compiles the main process, engine and renderer, then
replaces the `node_modules/onflip` symlink with a real copy of the engine —
electron-builder must not follow that link into the repository root — vendors
the engine's production dependencies (including the built `better-sqlite3`
binding and `prebuilds/`), runs electron-builder, and restores the symlink.

The result is `desktop/release/OnFlip-Setup-X.Y.Z.exe`. Attach it, and its
`.blockmap`, to the release.

## 3. Build the macOS artifacts

macOS artifacts cannot be cross-built from Windows: the `.app` carries symlinks
and the disk image needs `hdiutil`. Dispatch the workflow instead:

**Actions → macOS desktop build → Run workflow**, with the tag
(`desktop-vX.Y.Z`) as input.

It builds `release.js --mac` on a macOS runner and uploads `dmg` and `zip` for
both `arm64` and `x64` to that release.

The build runs unsigned (`CSC_IDENTITY_AUTO_DISCOVERY: false`), so a first
launch needs **right-click → Open → Open**.

## 4. Write the notes

Release notes describe what changed for someone using the app, not the commits:
what was broken and now is not, what is new and why it matters. If a limitation
came up while fixing something, say so plainly — the note about Chrome's cookie
encryption in 0.7.5 saves more support time than it costs.
