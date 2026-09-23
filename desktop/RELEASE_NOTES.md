# OnFlip Desktop 0.10.54

**Update checks are lighter and more reliable.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.54.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.54/OnFlip-Setup-0.10.54.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.54-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.54/OnFlip-0.10.54-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.54-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.54/OnFlip-0.10.54-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **Update checks no longer time out on a slow connection.** Since 0.10.52 every check read the last fifteen releases — nearly 300 KB — to be sure a command-line release could never hide a desktop one, and on a slow link that could run past the check's time limit, so the update offer silently did not appear. The check now asks for the latest release first (about 20 KB) and reads the list only when that is not a desktop release. A request that stalls or drops is tried once more before the check gives up.

Everything from 0.10.52 and 0.10.53 is included: follow-up requests that go straight to the work, edits that land exactly where they were asked, tasks that end without a repeated summary, and faster Qwen sends.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.53...desktop-v0.10.54](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.53...desktop-v0.10.54)
