# OnFlip Desktop 0.8.7

**OnFlip now updates itself.** Previous versions could tell you a new one existed and then hand you a download page. This one checks quietly in the background, offers the update when there is one, and installs it — download, quit, install, reopen — without you visiting GitHub.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.8.7.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.7/OnFlip-Setup-0.8.7.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.8.7-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.7/OnFlip-0.8.7-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.8.7-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.7/OnFlip-0.8.7-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

This is the first release that can install the next one. Updating *to* 0.8.7 is still a manual download; from here on it is a button.

## New: updates install themselves

- **It checks on its own.** Ninety seconds after launch, then every six hours. Nothing to click, and no check happens while you are mid-turn.
- **It tells you once.** A new version announces itself with an **Update** button and then stays quiet — the same version is never announced at you twice.
- **It shows you the download.** Clicking Update opens a progress screen rather than a spinner, so a slow connection looks slow instead of broken.
- **It finishes the job.** The app closes itself and the installer runs. On Windows that is the normal installer in silent mode; on macOS the app bundle is swapped in place, and the old one is put back if the swap fails.

The build is unsigned, so this is exactly what you would have done by hand — fetch the file this release publishes and run it — with one thing added: the download's length is checked against what GitHub said it would be. A half-downloaded installer is worse than none, because it runs and fails halfway. Nothing is touched while the app is alive.

## Fixed

- **Every bulleted list came back broken.** Replies are read back out of the rendered page, and the page indents its own HTML. That indentation was being read as content, so a bullet arrived with its marker alone on one line and its text on the next, and numbered lists lost their numbers entirely. Worse, the same stray indentation put four spaces in front of the second paragraph of a reply — which Markdown reads as a code block, so ordinary prose was displayed as code. This also fed straight back into the agent: when a long session is summarised, the summary is what the agent reads next.
- **A background server that had died still looked alive.** The message saying a server started stayed in the conversation looking true forever. In one session the agent checked a web page against a server that had exited some time earlier, failed, guessed wrong about why, and failed again the same way — two turns spent on a port nobody was listening to. The agent is now told which of its background jobs are still running and which are gone.
- **Long sessions could change language mid-answer.** When a session grows too long, OnFlip summarises it and continues from the summary. The summary was the only surviving copy of the request — so an English session on a Russian-language Windows install compacted, and every reply after that point came back in Russian, imitating the only text left in view. Your request is now carried through the summary word for word.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

## Under the hood

173 automated tests run on every push, up from 144. The new ones pin the page reader against markup shaped the way the real page is shaped — indentation included, because a test built from tidy HTML passes against the broken reader and proves nothing.
