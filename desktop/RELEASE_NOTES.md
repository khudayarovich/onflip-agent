# OnFlip Desktop 0.10.61

**On a Free ChatGPT account, OnFlip now runs on the GPT-5.6 Luna that has no limit.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.61.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.61/OnFlip-Setup-0.10.61.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.61-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.61/OnFlip-0.10.61-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.61-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.61/OnFlip-0.10.61-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**ChatGPT**

- **Free accounts run on the unlimited GPT-5.6 Luna.** A Free account's model list has two models called "GPT-5.6 Luna", and OnFlip picked the first — the one with a message limit, which also thinks on the Free plan's small thinking allowance. The default is now the one with no limit, and on Free the model picker offers only models the plan can run without a limit. If you picked a limited model yourself, OnFlip keeps your choice and says once, at start, that it has a limit. Go accounts get the same treatment.
- **No more false warnings about replies.** 0.10.60 checked each reply the page showed against ChatGPT's own copy, and marked many as different because the AI adds a label to its tool blocks that the page does not show. The replies were right either way; the log is now quiet about it.
- **Plan names read properly** in OnFlip's notices: "Free", not "Free · ~32k token context".

Everything from 0.10.60 is included: replies in long chats are read again, a usage limit is a pause rather than a loop, and the plan follows the account you sign in with.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.60...desktop-v0.10.61](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.60...desktop-v0.10.61)
