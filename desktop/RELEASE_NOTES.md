# OnFlip Desktop 0.10.14

**The context meter now says where its number came from.** The ring next to the composer has always shown how full the conversation is. It never showed what it was full *of* — and a budget ten times smaller than it should be looks exactly like a long conversation.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.14.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.14/OnFlip-Setup-0.10.14.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.14-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.14/OnFlip-0.10.14-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.14-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.14/OnFlip-0.10.14-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**Click the context ring and it now tells you "Sized by".** In words, not a number: *what one message can carry*, *your Plus plan*, *DeepSeek's own limit*, *your own setting*, or *the default for an unread plan*. The size and the explanation are worked out by the same code, so the label cannot drift away from the number it explains.

This is the piece that was missing when a stale plan value sized one account's conversation at a tenth of what it was entitled to. The meter was correct the whole time — it read full, because the conversation really was full of a window that was far too small. Nothing on screen said which window, so there was nothing to notice.

**A warning when the conversation has less room than the instructions.** If the budget drops below the size of OnFlip's own system prompt, the menu now says so plainly: the chat will summarise itself almost every turn, and every summary opens a fresh conversation and replays everything into it. That is what makes a wrong budget expensive rather than merely cramped — it is how an account gets rate-limited. The message points at the plan shown in About and at the size setting in Settings.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.13...desktop-v0.10.14](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.13...desktop-v0.10.14)
