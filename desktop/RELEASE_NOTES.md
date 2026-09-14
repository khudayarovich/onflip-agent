# OnFlip Desktop 0.10.17

**DeepSeek was being told it could do things only ChatGPT can do.** The instructions OnFlip sends at the start of every conversation were written when ChatGPT was the only service, and still said so — including a promise about images that DeepSeek had no way to keep.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.17.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.17/OnFlip-Setup-0.10.17.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.17-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.17/OnFlip-0.10.17-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.17-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.17/OnFlip-0.10.17-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**DeepSeek is no longer told it can draw pictures into your folder.** When ChatGPT draws an image, OnFlip lifts it off the page and saves it into the working folder — and the instructions spent a paragraph explaining that. DeepSeek has no such thing, so on DeepSeek that paragraph was asking for a file that would never appear, inside instructions whose main theme is never claiming to have saved something you did not save. It is gone there, along with the rules about refusing ChatGPT's own agent products, and the line naming ChatGPT's sandbox now names whichever service is actually answering.

**A tool that could not work is no longer offered.** `send_file` sends a file to your Telegram chat, and it was described to the model on every single session — including the great majority with no Telegram bot set up. The model would reach for it, wait for a round trip, and be told there was nowhere to send anything. OnFlip now tells the engine whether a bot is actually running, so the tool appears when it would work and not otherwise.

## Why this is worth a release

Those instructions are re-sent in full every time a conversation starts, and their size is subtracted from your context budget — so they decide both what each fresh conversation costs and how soon the chat has to summarise itself. Measured on one machine, the messages carrying them were 36% of everything the app had ever sent.

| | before | after |
| --- | --- | --- |
| ChatGPT, no Telegram | 23,172 | 22,542 |
| ChatGPT with Telegram | 23,172 | 23,172 |
| **DeepSeek, no Telegram** | 23,172 | **20,985** |
| DeepSeek with Telegram | 23,172 | 21,615 |

The ChatGPT instructions are otherwise unchanged, deliberately and with a test holding them there: everything in them was learned from things that went wrong on ChatGPT, and none of it moves.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.16...desktop-v0.10.17](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.16...desktop-v0.10.17)
