# OnFlip Desktop 0.10.24

**OnFlip drives Qwen now, alongside ChatGPT and DeepSeek.** A third free account to run the agent on, chosen from the account menu, with its own sign-in and its own chats.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.24.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.24/OnFlip-Setup-0.10.24.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.24-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.24/OnFlip-0.10.24-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.24-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.24/OnFlip-0.10.24-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**Qwen, as a third service.** Pick it from the account menu — the service list is there now, with all three and a tick on the one you are using — and OnFlip drives `chat.qwen.ai` the same way it drives the other two: a real browser, a real account, no API key. The title bar says **OnFlip × Qwen** so you can see which one is answering from across the room.

It is free, it offers two models (Qwen3.7-Plus and Qwen3.8-Max), and it decides for itself when a question is worth thinking about — so there is no reasoning control on Qwen, because there is nothing on its page for one to drive.

Each service keeps its own sign-in, its own chats and its own settings, exactly as ChatGPT and DeepSeek already do. Signing in to Qwen means signing in once more, in its own browser profile; nothing carries across, which is the point.

Two things Qwen does not have yet: attachments, which OnFlip now **declines out loud** in the composer rather than quietly dropping, and reopening a chat it did not start.

## Fixed

**A ChatGPT name could appear on another service's account bar.** The account panel showed a real name and email over a DeepSeek or Qwen session that had never been signed in to — in one case directly above a banner saying the app was not signed in. OnFlip was reading the account from ChatGPT's own session endpoint whoever was running, and filing it under the service that happened to be active. It is filed by whose it is now, and a name that was already misfiled is ignored rather than shown.

**Three colours that were never defined.** Eleven style rules pointed at theme colours that do not exist, which does not make them dim — it makes the whole declaration invalid. Four pieces of text meant to read as secondary were rendering at full strength, and the update dialog had no background at all: its heading, progress bar and buttons sat directly on the blurred page behind it.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.23...desktop-v0.10.24](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.23...desktop-v0.10.24)
