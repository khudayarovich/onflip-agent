# OnFlip Desktop 0.10.57

**Passwords stay in the page.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.57.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.57/OnFlip-Setup-0.10.57.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.57-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.57/OnFlip-0.10.57-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.57-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.57/OnFlip-0.10.57-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **What is in a password field is no longer sent to the AI.** After every step in the agent's browser, OnFlip describes the page to the AI, and that description included the contents of password fields — so a password you typed into the browser panel yourself, or one the browser filled in for you, went to ChatGPT, DeepSeek or Qwen and stayed in the chat's history. The AI is now told only that the field is filled and how long the entry is.
- **Typed text is hidden in the chat's tool cards.** Expanding a *Type Text* card showed what was typed, a password included, and it showed it again every time the chat was reopened. Typed text now appears as dots. You still see what will be typed, and where, in the approval prompt before anything happens, with password fields masked there as before.

Everything from 0.10.56 is included: usage counts and importing a browser session on Intel Macs, the project map, *Find Definition*, remembered checks, forms in one step, a quieter app when you are away, and approval for changes to instruction files.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.56...desktop-v0.10.57](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.56...desktop-v0.10.57)
