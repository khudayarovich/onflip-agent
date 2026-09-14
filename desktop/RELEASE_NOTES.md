# OnFlip Desktop 0.10.21

**When OnFlip trims old tool output, the part it cut is now one read away instead of one re-run away.** 0.10.20 started shortening old results to keep long chats going without summarising. It worked, but the note it left behind could only say "run the tool again" — and for the results actually worth cutting, that means paying for the same answer twice.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.21.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.21/OnFlip-Setup-0.10.21.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.21-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.21/OnFlip-0.10.21-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.21-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.21/OnFlip-0.10.21-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**Trimmed output is saved, not discarded.** Before OnFlip shortens an old tool result, it writes the whole thing to a file and puts the path in the note it leaves behind. The agent reads that file — with the ordinary `read` tool, asking for whichever part it needs — instead of running a two-minute build or an expensive search a second time.

That matters most for exactly the results big enough to be worth cutting. A short one was never the problem.

**The files are kept carefully.** Tool output is whatever a command on your machine happened to print, so it goes into a private directory under `~/.onflip/spill`, under a name nobody can guess, created in a way that refuses to follow a symlink left in its place. Three hundred are kept and the oldest are dropped, the same way session logs are.

**And if the file cannot be written, the trim still happens.** Saving the output is an improvement on shortening it, not a condition for it — a full disk means a shorter conversation with a note that says to re-run, never a conversation left to grow until it has to be summarised.

The approach is DeepSeek's, from the spill storage in their open-source agent harness: persist the output, hand back a locator and how to use it.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.20...desktop-v0.10.21](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.20...desktop-v0.10.21)
