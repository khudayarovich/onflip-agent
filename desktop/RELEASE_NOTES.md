# OnFlip Desktop 0.8.8

**A quieter, better-behaved window.** Icons that are drawn rather than typed, the plumbing chatter folded away, sessions that remember what they were about and how long each turn took — and the reload keys can no longer throw your work off the screen.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.8.8.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.8/OnFlip-Setup-0.8.8.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.8.8-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.8/OnFlip-0.8.8-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.8.8-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.8/OnFlip-0.8.8-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 already?** You should not need this page. 0.8.7 was the first build that can install the next one, so it will offer this update by itself.

## What changed

- **The icons are drawn now.** Every arrow, folder, tick and cross was a text character before, which meant they looked different on every machine and none of them could move. The one that mattered: a tool card is a dropdown, and nothing on it said so — the Run Command card's own icon was a "▸" that read as a collapsed arrow and never opened. There is now a real arrow at the end of every card, and it turns when the card does.
- **The plumbing chatter is folded away.** Lines like "ChatGPT could not read the attached turn file, retrying" are OnFlip talking about its own recovery — each one describes something it then handled by itself. Printed between your messages they were the loudest thing on screen during a turn that was going perfectly well. They are now a single quiet line you can click to open, rather than being shouted at you.
- **Sessions are named after what you asked.** The sidebar took its title from the first message in the session, which after a long turn was OnFlip's own handover note — so compacted sessions sat in the list all called "[Context carried over from the ea…". Sessions whose request had been archived showed "(empty session)", and one whose conversation ChatGPT had named after an internal marker read "[attachment unreadable]". All three now show the request. Sessions already in your list fix themselves.
- **How long each turn took is kept.** "Worked for 4m" was shown when a turn finished and then lost the moment the session was reopened. It is now recovered from the session itself, which means it appears for turns you ran weeks ago as well as new ones.
- **Ctrl+F5 no longer throws the window away.** It reloaded the renderer — the transcript, and any approval prompt waiting on an answer — while the engine carried on working for a window that no longer existed. F5, Ctrl+R and Ctrl+Shift+R are all held now.
- **The account row loses its avatar disc.** An initial in a coloured circle was decoration, and the only thing in the sidebar competing for attention with your sessions.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

## Under the hood

202 automated tests run on every push, up from 173. The Windows job had also been failing at random — on commits that changed nothing but Markdown — because a test was asserting against a timing budget tuned on a warm machine, and a cold CI runner could not meet it. Red builds nobody can explain are worse than none, so that is fixed too.
