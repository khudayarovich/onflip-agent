# OnFlip Desktop 0.10.49

**Arena now holds one conversation instead of opening a new one per message — which is also why the captcha stops coming on every send.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.49.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.49/OnFlip-Setup-0.10.49.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.49-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.49/OnFlip-0.10.49-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.49-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.49/OnFlip-0.10.49-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Arena opened a fresh conversation for every message — and paid for it three times over.**

Since Arena arrived, each message started a brand-new chat: the entire transcript re-sent every time, Arena's model router rolling dice on every message, and — the part that made it unbearable — a captcha on every send for some networks, because what Cloudflare challenges is *new conversations*, and every message was one.

Arena now keeps one conversation per session, sending only what is new each turn, like the other three services. Measured: a follow-up message carries a few dozen characters instead of tens of thousands and answers in under four seconds. A captcha, if your network gets one at all, comes at most when a conversation starts — click it once and the thread is yours.

Three driver bugs fell in the process, each of which could return a wrong or stale answer in a continuing conversation:

- Arena's conversation page lists messages **newest-first**, so "the last reply" was actually the **oldest** — a follow-up could come back wearing the previous answer. The newest reply is now found by where it sits on screen, which is bottom-most in every layout.
- The Direct-mode switch could kill the send it was meant to protect (choosing it navigates the page mid-send). It is no longer forced — signed-in chats answer correctly without it.
- A conversation's first message now gets the same patient page-opening that every message used to get.

**If replies introduce themselves instead of working** ("I am Gemini 3.7 Flash…"), that is Arena's **Max** router handing your message to a lightweight model. Pick a specific model from the model chip instead of Max — Max optimizes Arena's model comparisons, not your task.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.48...desktop-v0.10.49](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.48...desktop-v0.10.49)
