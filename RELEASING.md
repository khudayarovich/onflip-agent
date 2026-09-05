# Releasing

A release is the desktop app: Windows and macOS artifacts on one GitHub
Release, all of them built by `.github/workflows/desktop-release.yml` when the
tag is pushed. Nothing is built by hand and nothing is uploaded by hand.

Desktop releases are tagged `desktop-vX.Y.Z`.

## 1. Write the release page first

The workflow creates the release from `desktop/RELEASE_NOTES.md` if that file
exists, and falls back to generated notes if it does not — so the notes have
to be committed *before* the tag, not after. Section 4 is what to put in them.

## 2. Version and tag

```bash
cd desktop
npm --no-git-tag-version version X.Y.Z   # package.json and package-lock.json
cd ..
git commit -am "OnFlip Desktop X.Y.Z: <what changed>"
git push origin main
git tag desktop-vX.Y.Z
git push origin desktop-vX.Y.Z
```

Pushing the tag is the release. The version in `desktop/package.json` must
match the tag: it is what the running app reports as its own version, and the
update check compares the two.

## 3. What the workflow does

**Windows first**, because that job creates the release. `scripts/release.js`
compiles the main process, engine and renderer, then replaces the
`node_modules/onflip` symlink with a real copy of the engine — electron-builder
must not follow that link into the repository root — vendors the engine's
production dependencies (including the built `better-sqlite3` binding and
`prebuilds/`), runs electron-builder, and restores the symlink. It uploads
`OnFlip-Setup-X.Y.Z.exe` and its `.blockmap`.

**macOS second**, on a real Mac: the artifacts cannot be cross-built from
Windows, because the `.app` carries symlinks and the disk image needs
`hdiutil`. It runs `release.js --mac` and attaches `dmg` and `zip` for both
`arm64` and `x64` to the release the Windows job made.

Both build unsigned (`CSC_IDENTITY_AUTO_DISCOVERY: false`); the mac build
ad-hoc signs itself in `afterPack`, so a first launch needs
**right-click → Open → Open**.

The `.zip` is not a convenience copy — it is what the in-app updater installs
on macOS, because it holds the `.app` directly and nothing has to be mounted.
Do not drop it from the release.

**To rebuild without moving the tag:** *Actions → Desktop release → Run
workflow*, with the tag as input. It uploads with `--clobber` and reuses the
existing release.

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