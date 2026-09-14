# OnFlip Desktop 0.10.20

**Long conversations now cost far less to keep going.** When the chat filled up, OnFlip summarised it — which means one extra request, a brand-new conversation, and the whole thing typed in again. It now tries something free first, and most of the time that's enough.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.20.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.20/OnFlip-Setup-0.10.20.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.20-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.20/OnFlip-0.10.20-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.20-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.20/OnFlip-0.10.20-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

**On macOS and on 0.10.19?** That release only published a Windows build — the macOS half failed on a dependency install. This one replaces it.

## New

**Old tool output gets trimmed before anything gets summarised.** Most of what fills up a long chat is not the conversation — it is the output of tools. A file the agent read, a directory listing, a build log: bulky, already acted on, and the part nobody refers back to.

Counted from real sessions on one machine: 334 tool results carrying 647,671 characters, and 127 of them — the ones over two thousand characters — held **85% of all of it**. Cutting the middle out of those reclaims **376,108 characters, 58% of all tool output**, and costs nothing at all: no request, no waiting, no summary.

So that is what OnFlip tries first now. Only if trimming was not enough does the conversation get summarised — and that is the step that used to cost a request, a fresh chat, and a full re-send every time.

Two things it will not do. **The newest results are never touched**, because those are what the agent is working from right now — a file it just read and is about to edit. And **nothing is trimmed twice**, which would eat away at what is left until a result said nothing but "something was cut". Where output is removed it says so, says how much, and tells the agent to run the tool again rather than work from memory. The full output stays in the session log either way.

The idea comes from DeepSeek's open-source agent harness, which does the same thing for the same reason.

## Fixed

**A flaky dependency install no longer costs a platform.** 0.10.19 published a Windows build and no macOS one because `npm install` failed on the macOS runner, minutes after the identical install had worked. It now retries once before giving up.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.19...desktop-v0.10.20](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.19...desktop-v0.10.20)
