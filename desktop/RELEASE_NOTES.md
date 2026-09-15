# OnFlip Desktop 0.10.27

**Switch service from Telegram.** `/provider` moves OnFlip between ChatGPT, DeepSeek and Qwen without going near the machine.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.27.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.27/OnFlip-Setup-0.10.27.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.27-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.27/OnFlip-0.10.27-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.27-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.27/OnFlip-0.10.27-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**`/provider` — switch service from your phone.** Pick ChatGPT, DeepSeek or Qwen and OnFlip moves across. The one you are on is shown with a tick and has no button, since pressing it would restart the app to arrive where it already is.

It tells you what it costs before you press anything: switching restarts OnFlip, so the bot goes quiet for a few seconds and any turn running is lost. The confirmation is sent *before* the switch — after a restart nothing queued is ever delivered.

There is a **🔌 Service** button in `/settings` too.

**`/status` now says which service is answering.** The model names differ per service, so a card showing `qwen3-plus` without saying whose it is was telling you the less useful half.

## Fixed

**`/thinking` offered four levels on services that do not have four.** DeepSeek has a single Deep-thinking toggle, so three of the four buttons were the same button; Qwen has no reasoning control at all and decides for itself, so all four did nothing. The picker now offers what the service actually has, and says so plainly on Qwen.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.26...desktop-v0.10.27](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.26...desktop-v0.10.27)
