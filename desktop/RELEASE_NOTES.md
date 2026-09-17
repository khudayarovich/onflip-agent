# OnFlip Desktop 0.10.51

**Answers keep their formatting, Arena has been retired, and Qwen responds with less browser overhead.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.51.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.51/OnFlip-Setup-0.10.51.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.51-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.51/OnFlip-0.10.51-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.51-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.51/OnFlip-0.10.51-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **Formatted answers stay formatted.** Nested Markdown fences are preserved through browser extraction, tool parsing, live streaming and saved-session replay, so headings, lists and code examples no longer appear as raw or broken text.
- Terminal tool output can contain its own fenced code safely without prematurely closing the surrounding tool block.

## Improved

- **Qwen replies complete sooner.** Browser state is collected in one bounded read, sent messages are detected immediately, and the fast path avoids a redundant settling delay. This removes up to about 0.9 seconds of local browser overhead while leaving Qwen's own generation time unchanged.
- Provider and replay regression coverage now includes nested fences and final-answer presentation.

## Changed

- **Arena has been removed.** Reliable automation required a visible browser and repeated human CAPTCHA checks, making it unsuitable as an unattended provider. Existing Arena selections fall back safely to ChatGPT; local profile data is left untouched.
- Provider settings, sign-in guidance and documentation now list ChatGPT, DeepSeek and Qwen only.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.50...desktop-v0.10.51](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.50...desktop-v0.10.51)
