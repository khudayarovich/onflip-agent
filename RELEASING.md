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

## 4. Write the release page

The release page is where most people meet OnFlip — a download link shared
anywhere lands there, not on the README. Treat it as a product page rather
than a changelog dump. The shape that works:

```markdown
One sentence on what changed for someone using the app.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-X.Y.Z.exe](.../releases/download/desktop-vX.Y.Z/OnFlip-Setup-X.Y.Z.exe) | 83 MB |
| **macOS** · Apple Silicon | [OnFlip-X.Y.Z-mac-arm64.dmg](...) | 104 MB |
| **macOS** · Intel | [OnFlip-X.Y.Z-mac-x64.dmg](...) | 110 MB |

## Installing
Windows: unsigned, so SmartScreen warns — More info → Run anyway.
macOS: unsigned, so the first launch needs right-click → Open → Open.

## What's new
## Fixed
## Requirements

**Full changelog:** [desktop-vPREV...desktop-vX.Y.Z](.../compare/...)
```

Direct download links matter. The asset list at the bottom of the page is easy
to miss, and the `.zip` and `.blockmap` files sitting beside the installer make
people hesitate over which one they need — so say it.

Notes describe what changed for someone using the app, not the commits. If a
limitation surfaced while fixing something, state it plainly: the note about
Chrome's cookie encryption in 0.7.5 saves more support time than it costs, and
a page that admits a limit is trusted more than one that does not.