# OnFlip Desktop 0.10.12

**A new way to edit files that actually works, and skills — instructions the agent reads only when a task needs them.** Plus the update button finally says why it sometimes sends you to a browser.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.12.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.12/OnFlip-Setup-0.10.12.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.12-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.12/OnFlip-0.10.12-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.12-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.12/OnFlip-0.10.12-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

**File edits should fail far less often.** Measured across real sessions: 16% of all the agent's tool calls failed, and the editing tool alone failed **57% of the time** — the worst number in the product, and every failure costs a wasted exchange with the model. The cause was the contract rather than a bug: editing asked the model to reproduce a chunk of your file exactly, character for character, which it cannot reliably do once the file has scrolled out of its memory. It would rebuild the chunk from recollection and miss by a space.

There is now a `patch` tool that takes an ordinary diff instead. A diff carries its own line numbers and surrounding context, so OnFlip can go and *find* the right place rather than demanding a perfect match — and when the file has moved on underneath, it says so instead of refusing. If a patch cannot be applied, nothing is written and the agent is told which part did not fit, what it expected, and what is actually there.

**Skills.** Put a `SKILL.md` in `.onflip/skills/<name>/` in a project, or in `~/.onflip/skills/` for every project, and OnFlip will know it exists and read it when a task matches. Give it a name and a one-line description at the top:

```
---
name: deploy
description: Ship a build to staging. Use when asked to deploy or release.
---
```

The point is what it *doesn't* cost. Instructions in `AGENTS.md` are re-sent to the model on every single turn and eat into how much conversation OnFlip can keep — which is why there is a size limit on them, and why a large one is skipped entirely. A skill only puts its name and that one line in front of the model; the body stays on disk until it is actually needed. Three skills cost about 700 characters. Their bodies can be any size at all. If you have an instruction file that grew too large to load, this is where the rest of it goes.

## Fixed

**The update button says why it sometimes opens your browser.** OnFlip does install updates by itself, on both Windows and macOS. When it cannot, it falls back to the download page — and it used to do that in silence, which reads as the feature not existing. It now tells you what stopped it. The reason was also wrong: three different situations all claimed "no installable build for this platform", when the usual cause is simply that the check to GitHub failed, which is rate-limited and shared with the automatic check on a timer.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.11...desktop-v0.10.12](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.11...desktop-v0.10.12)
