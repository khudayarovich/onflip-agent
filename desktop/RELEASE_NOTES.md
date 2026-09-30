# OnFlip Desktop 0.10.68

**"Compact after" can go back to automatic from Settings.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.68.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.68/OnFlip-Setup-0.10.68.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.68-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.68/OnFlip-0.10.68-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.68-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.68/OnFlip-0.10.68-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **"Compact after" can be handed back to automatic.** Once a number had been typed into Settings → "Compact after (characters)", there was no way back: the field would only save another number, so the value stayed until someone edited OnFlip's config file by hand. While your own number is set, an **Automatic** button now sits beside the field, and clearing the box does the same. OnFlip then sizes the conversation from your plan and model again.

Everything from 0.10.67 is included: when ChatGPT will not take a message, OnFlip works out whether to wait or to send less instead of retrying in a loop, and the agent can click buttons however it writes their reference, including on menus a game keeps redrawing.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.67...desktop-v0.10.68](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.67...desktop-v0.10.68)
