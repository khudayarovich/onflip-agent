# OnFlip Desktop 0.10.63

**Full-auto no longer stops to ask before deleting a single temporary file, and the agent's browser understands key names however they are written.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.63.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.63/OnFlip-Setup-0.10.63.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.63-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.63/OnFlip-0.10.63-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.63-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.63/OnFlip-0.10.63-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Full-auto**

- **No approval prompt for deleting one named file.** The agent often checks its code by writing it to a temporary file, testing it, and deleting the file again with a "force" option. OnFlip treated any forced delete as dangerous and stopped to ask, even in full-auto, so a one-second check could sit waiting for approval for many minutes — in one session, about 48 minutes in total. A forced delete of one file the command names now runs like any other command in full-auto. Everything that could remove more still asks first: deleting folders, deleting with wildcards like `*`, lists of files, filters, and files chosen by another command.

**The agent's browser**

- **Key names in any capitalization.** The agent pressing "TAB" or "ESC" failed, because the browser only accepts "Tab" and "Escape". Key names and shortcuts like "ctrl+a" now work however they are written.

Everything from 0.10.62 is included: the agent's browser works with the Browser panel closed, and OnFlip tells ChatGPT when it reaches for tools that cannot see your computer.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.62...desktop-v0.10.63](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.62...desktop-v0.10.63)
