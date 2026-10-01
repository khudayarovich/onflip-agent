# OnFlip Desktop 0.10.70

**The About page knows all four services.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.70.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.70/OnFlip-Setup-0.10.70.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.70-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.70/OnFlip-0.10.70-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.70-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.70/OnFlip-0.10.70-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **The About page describes Gemini API.** The Services section gains the fourth row — its logo, the pasted-key sign-in, the model list read from your key, and free-tier limits that are waited out rather than billed — in English, Russian and Uzbek. Its "How it works" paragraph no longer claims "no API key" flatly, now that one service is exactly that, and DeepSeek's description matches the one-model service it has been since September.

Everything from 0.10.69 is included: Google's Gemini API as the fourth service — a free AI Studio key pasted in Settings, the model picker read from the key itself, and a paste box that finds the key in whatever actually lands in it.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — or a free Google AI Studio API key for Gemini. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.69...desktop-v0.10.70](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.69...desktop-v0.10.70)
