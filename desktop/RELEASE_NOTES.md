# OnFlip Desktop 0.10.7

**The built-in browser sits straight in its panel again, and sessions keep far more of the conversation before compacting.** Two fixes reported straight after 0.10.6: the browser page ending up misaligned with the frame around it, and the transcript being summarised every few turns.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.7.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.7/OnFlip-Setup-0.10.7.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.7-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.7/OnFlip-0.10.7-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.7-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.7/OnFlip-0.10.7-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The built-in browser no longer fights its own frame.** Scrolling worked, but the page could end up rendering at a size the panel does not have — text cut off at the edge, the page sitting out of step with the frame around it. Resizing the panel was applying a fixed render size to a view whose size the window already sets, and it stayed fixed from then on. Measured in the app: the page was rendering 650 pixels wide inside a 430-pixel frame. The panel now leaves the real view to the window, and opening the browser clears the mismatch on a session that already has one — no restart needed.

**Sessions keep much more of the conversation.** 0.10.5 stopped sending large turns as files, which is what was getting accounts rate-limited — but it also left every plan sizing its transcript from the smaller typed limit, so conversations were being summarised every few turns and losing their thread. The budget goes from 28,000 to 40,000 characters, which is about 43% more conversation before anything is compacted, and still inside what the composer is proven to accept in one go. Accounts whose own context window is smaller than that are unchanged — they were never limited by this number.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.6...desktop-v0.10.7](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.6...desktop-v0.10.7)
