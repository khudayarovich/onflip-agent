# OnFlip Desktop 0.10.38

**The "always allow" button, filling half the permission dialog with the command it was offering to remember.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.38.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.38/OnFlip-Setup-0.10.38.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.38-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.38/OnFlip-0.10.38-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.38-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.38/OnFlip-0.10.38-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The permission dialog's "always allow" button was unreadable.**

It used to read *Always allow "<the whole command>"*, which was fine when a remembered command was something short like `python`. It is not short any more: since 0.10.32 an "always allow" remembers the **exact** command and nothing else, so writing a file with a here-document put the entire file inside the button.

The button now just says **Always allow**. What it would remember appears in its own block above the buttons, trimmed to three lines, with the whole thing on hover.

That block is still worth showing rather than dropping. A here-document is many lines on screen but one long line in the saved list — so what gets remembered includes the file contents, and will almost certainly never match again. Better to see that before agreeing to it. For an ordinary command like `npm test`, where there is nothing surprising to say, the block does not appear at all.

**And on Telegram it said it twice.** The button read *"Always allow Always allow "pyth…"* — the phrase once from the button and once from the label, then cut short, so the part that survived was the part that told you nothing.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.37...desktop-v0.10.38](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.37...desktop-v0.10.38)
