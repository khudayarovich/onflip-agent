# OnFlip Desktop 0.10.56

**On Intel Macs, usage counts and importing a browser session now work.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.56.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.56/OnFlip-Setup-0.10.56.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.56-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.56/OnFlip-0.10.56-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.56-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.56/OnFlip-0.10.56-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **Intel Macs: usage counts and importing a browser session.** The Mac app is built on an Apple Silicon machine, so the database component inside the Intel build was the Apple Silicon one, which an Intel Mac cannot load. A working Intel copy has always shipped beside it as a backup, but OnFlip only switched to the backup for a different kind of failure — so on an Intel Mac the usage counter stayed at zero, and importing a ChatGPT session from Chrome or Firefox failed. It now switches whenever the main copy cannot run on the machine. Apple Silicon Macs and Windows were not affected.
- **Every Mac build is now checked before it is published.** The release opens the database inside each Mac build the way the app does, and the Intel build is run under Rosetta on an Apple Silicon machine, where it fails exactly as it would on a real Intel Mac — so this kind of break cannot ship unseen again.

Everything from 0.10.55 is included: the project map, *Find Definition*, remembered checks, forms in one step, a quieter app when you are away, and approval for changes to instruction files.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.55...desktop-v0.10.56](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.55...desktop-v0.10.56)
