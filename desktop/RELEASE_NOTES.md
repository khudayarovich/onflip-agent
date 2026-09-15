# OnFlip Desktop 0.10.42

**Two things Arena got wrong on its first outing: signing in did not stick, and the model list was ChatGPT's.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.42.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.42/OnFlip-Setup-0.10.42.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.42-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.42/OnFlip-0.10.42-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.42-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.42/OnFlip-0.10.42-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in to Arena opened a fresh browser every time and never took.**

OnFlip was waiting for the sign-in window to close — and on a Mac, closing a window does not close the application. So it waited, nothing appeared to happen, and pressing Sign in again started yet another browser on the same profile.

It now watches for your account arriving in the profile instead, which is what it actually wanted all along. Sign in, and OnFlip closes the window for you. There is no button to find.

**Arena offered ChatGPT's models.** The list of models a service offers had a fallback in it, so a newly added service quietly inherited a different one's. Arena now has its own — led by **Max**, Arena's own setting that picks the most capable model for each message. Six in the app out of the hundred-odd Arena lists; anything else can still be chosen on Arena's own page.

And choosing one now actually changes the model. Listing models that cannot be picked would be a menu that lies, which is not worth shipping to save an afternoon.

## Still true from 0.10.41

Arena starts a fresh conversation for every message rather than continuing one thread. It works, and it uses more of your allowance per message than it should. That is the next thing to improve.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.41...desktop-v0.10.42](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.41...desktop-v0.10.42)
