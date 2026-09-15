# OnFlip Desktop 0.10.41

**A fourth service — Arena — and the reason Qwen went quiet for four minutes instead of telling you it had hit its daily limit.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.41.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.41/OnFlip-Setup-0.10.41.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.41-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.41/OnFlip-0.10.41-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.41-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.41/OnFlip-0.10.41-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New — Arena

**[arena.ai](https://arena.ai) joins ChatGPT, DeepSeek and Qwen** in the service picker. Sign in with Google from the account menu, the same way as the others.

The reason to have it is the session. Arena keeps yours in cookies that last about **thirteen months**; Qwen hands the browser a new token on every answer and invalidates the one before it, which is why a Qwen session can end after an afternoon. If you have been signing in to Qwen over and over, Arena is the one that will still be signed in tomorrow.

**Being straight about what is not finished.** Arena starts a fresh conversation for every message rather than continuing one thread — the first message in a conversation is reliable and the second is not yet, so this takes the reliable path. It works, and it costs more of your allowance per message than it should, so treat Arena as usable rather than polished for now.

## Fixed

**Qwen going silent instead of saying it had hit its daily limit.**

The page said so, plainly, in its first line — *"You have reached the daily usage limit. Please wait 4 hours."* OnFlip read that page, recognised nothing in it, and waited out its whole window before reporting a silence it could not explain. It now reads that message in English and Russian, and repeats the wait the service named, so a four-hour limit is not something you discover by trying again every ten minutes.

**And when a service refuses a message, OnFlip now says so in about a second.** A send is confirmed by the page — the box empties, your message appears — which is exactly what these sites do *before* they post anything. So a message the service quietly refused left a conversation that looked completely normal with a question in it that nothing was working on. OnFlip now listens to what the service actually answered, so a refusal ends the turn with the reason instead of minutes of nothing.

**A message could be cut off without anyone being told.** The rule deciding how much text fits in one message read "Qwen, otherwise DeepSeek's figure" — so a new service silently inherited a limit measured for DeepSeek. Past a real limit a message is not rejected, it is truncated, and a truncated question gets answered as though it were the whole thing. Every service names its own now.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.40...desktop-v0.10.41](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.40...desktop-v0.10.41)
