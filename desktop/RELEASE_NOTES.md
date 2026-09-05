# OnFlip Desktop 0.8.6

**Four bugs that made OnFlip lie to itself.** None of them raised an error — the agent was told something untrue and worked from it, rewriting code that was already correct. All four came out of one real session log.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.8.6.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.6/OnFlip-Setup-0.8.6.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.8.6-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.6/OnFlip-0.8.6-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.8.6-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.6/OnFlip-0.8.6-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

## Fixed

- **Half of PowerShell produced no output at all.** Anything that returns objects rather than text — `Get-ChildItem | Select-Object`, `Get-Process`, most idiomatic PowerShell — came back completely empty. The agent would ask for a file listing, get nothing, and start doubting work that was fine. Plain strings were unaffected, which is why it looked like an occasional glitch instead of a rule.
- **"Started in the background" could be untrue.** A background command was reported as running the instant it was launched, before it could possibly have failed. On a machine without Python, `python -m http.server` was reported as started, and the agent then spent four turns investigating a server that never existed. It now waits for the command to prove it is alive, and says plainly when it died or simply finished.
- **A malformed code fence could delete a step.** When a reply closed a block with two backticks instead of three, the block *after* it was silently swallowed — two actions written, one performed, no error either way. The missing step then had to be redone on the next turn.
- **The browser told you to run a command that cannot work.** With no Chrome installed, the agent's browser suggested `npx playwright install` and then spent a turn watching it time out. OnFlip now fetches its own browser, and says so honestly if it cannot.

## Also in this release

- macOS and Linux no longer pay a Windows-sized delay when starting a background command. The two shells report a failure an order of magnitude apart — 37 ms against 761 ms — and each now waits only as long as it needs to.
- The health checks look in both places Chromium keeps its cookies, so a signed-in profile is never reported as signed out.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

## Under the hood

144 automated tests now run on every push, up from 126. The new ones cover both platforms' shell behaviour from either machine — the two differ in exactly the way that is easy to get wrong, and only one of them can be run at a time.

**Full changelog:** [desktop-v0.8.5...desktop-v0.8.6](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.8.5...desktop-v0.8.6)
