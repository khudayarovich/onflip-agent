# OnFlip Desktop 0.10.28

**A Qwen turn can no longer hang forever on "sending".** Every question OnFlip asks the page is now bounded, and a slow turn says where it is.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.28.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.28/OnFlip-Setup-0.10.28.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.28-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.28/OnFlip-0.10.28-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.28-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.28/OnFlip-0.10.28-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Turns stuck on "sending" with no error and nothing in the log.** Reported on macOS. OnFlip asks the Qwen page three questions during every turn — read the reply, fill the box, check the session — and none of them had a time limit. If the page stopped answering, OnFlip waited for it forever, showing "sending" and saying nothing.

All three are now bounded. If the page stops answering, the turn fails in twenty seconds with a message naming the step, and can be retried — instead of hanging until you give up.

**A slow turn now says where it is.** OnFlip writes a line when it opens the page, another when your message has landed and it starts waiting, and one every thirty seconds after that — including whether Qwen is still generating and how much of the answer has arrived. If something does stall, the log now says what it was doing rather than leaving it to be guessed.

**A Telegram command menu that Telegram rejected used to fail invisibly.** Telegram accepts the command list all-or-nothing, so one bad entry costs the whole menu — and the error went to a console a packaged app never shows. It appears on the Telegram settings card now.

<i>If a command is missing from the Menu button: Telegram's own apps cache that list for a few minutes. <code>/help</code> is written from the same table and is always current.</i>

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.27...desktop-v0.10.28](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.27...desktop-v0.10.28)
