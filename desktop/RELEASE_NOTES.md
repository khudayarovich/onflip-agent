# OnFlip Desktop 0.10.29

**Qwen turns that sat on "sending" and then blamed the send — found, and it was never the send.** Your Qwen session had quietly expired, and OnFlip could not tell.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.29.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.29/OnFlip-Setup-0.10.29.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.29-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.29/OnFlip-0.10.29-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.29-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.29/OnFlip-0.10.29-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The real cause of every stuck Qwen turn this week.** When a Qwen session lapses, Qwen does not say so — it quietly puts the browser into a *guest* chat, where messages are accepted and never answered. OnFlip kept waiting, then reported that the message had not sent. It had. There was simply nobody signed in to answer it.

OnFlip could not see this because Qwen leaves the expired sign-in token in place, at full length and looking entirely valid. The account bar said connected, every check passed, and every turn went somewhere that could not reply.

It now recognises the guest chat immediately — **the same second**, instead of after ninety — and tells you plainly that the session has expired and needs signing in again. The account bar corrects itself at the same moment, so it stops claiming a connection it has just been shown it does not have.

Nothing before a send can detect this: a lapsed Qwen profile shows a working message box, no sign-in prompt, an ordinary address and a valid-looking token. The first message is the first evidence there is, which is why it now costs one message rather than a minute and a half.

**Qwen messages are now paced.** A session that dies after a few minutes of agent work is a service reacting to load, so OnFlip leaves the same small gap between messages it has always left for ChatGPT, and a wider one between new chats. It should make the lapse less frequent; it cannot make Qwen sessions permanent.

**`/status` in Telegram now shows the version.** Diagnosing a fault on another machine starts with knowing what is running on it, and every way to find that out ran through the app's own window.

<i>If Qwen stops answering: sign in again from the account menu. Qwen ends sessions on its own, and OnFlip cannot renew one for you — it can only tell you promptly, which it now does.</i>

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.28...desktop-v0.10.29](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.28...desktop-v0.10.29)
