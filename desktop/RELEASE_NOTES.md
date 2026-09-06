# OnFlip Desktop 0.10.2

**Files, both ways, over Telegram.** Ask the bot for a file on your desktop and it arrives as a file. Send it one and the agent can work with it. The bot's Menu button also has the commands in it now, and stop ends a turn even when the page has stopped listening.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.2.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.2/OnFlip-Setup-0.10.2.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.2-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.2/OnFlip-0.10.2-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.2-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.2/OnFlip-0.10.2-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

**Ask for a file and get the file.** "Send me the report on my desktop", "forward today's log" — it arrives in the chat as a real document you can open or save, up to Telegram's 50 MB. It asks before sending, because the file does leave the machine, and read-only mode never offers it. Every refusal says what is wrong: a folder named instead of a file, an empty one, one over the limit, a bot that is not running.

**Send the bot a file and the agent can work with it.** Until now a file sent to the bot did nothing at all — the message carried no text, so nothing happened and the file stayed in Telegram. Now it is downloaded to `~/.onflip/inbox` and the agent is handed the path. With a caption the caption becomes the request — "summarise this", "convert this to csv" — and without one it is saved quietly and confirmed, so your next message can refer to it. Documents, photos, video, audio and voice notes, up to the 20 MB Telegram allows a bot to download. An image goes to the model as an image, since looking at it is usually the point.

Incoming files land in their own folder rather than inside whatever project is open: a folder appearing in your git checkout because somebody sent a photo is a surprise in the wrong place.

**The Menu button works.** Telegram fills it from the bot, and the bot had never told it anything — every command worked and none could be found. It publishes them on connect now.

## Fixed

**Stop now ends a turn that has stopped listening.** Reported as two things that are one thing: a turn silent for nearly six minutes, and stop doing nothing about it. Stopping aborts a signal, and a signal only stops something watching it — every poll loop does, but a page whose JavaScript thread is wedged never answers, so the loop never comes back around to look. After five seconds of a stop not landing, OnFlip closes its browser: every pending call rejects, the turn ends, and the next message opens it again. A healthy stop still lands in about half a second and never reaches this.

**The silence warning stopped promising a countdown.** It said "restarts by itself in about 4 more", was written once, and then sat there while the clock ran — so by minute five it read as a broken promise. It now names the time it will act at, and says that stop ends it now.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.1...desktop-v0.10.2](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.1...desktop-v0.10.2)
