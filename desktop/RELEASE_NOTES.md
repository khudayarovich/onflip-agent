# OnFlip Desktop 0.10.25

**Qwen turns that failed saying you were signed out, when you were not.** A fix for the one real problem in yesterday's release.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.25.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.25/OnFlip-Setup-0.10.25.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.25-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.25/OnFlip-0.10.25-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.25-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.25/OnFlip-0.10.25-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**"The browser profile is signed out of Qwen, so the message went nowhere" — on a profile that was signed in the whole time.** Reported on macOS, often enough that retrying became a habit. It was never your session.

A browser's stored session belongs to one website, not to the browser. While OnFlip's hidden browser was still on its way to Qwen — a blank page, an error page, a page part-way through loading — it looked for your Qwen session *on that page*, found nothing, and concluded you were signed out. You were not; it was simply looking in the wrong place, and a slower machine leaves it looking there for longer. That is why a Mac saw it and why sending again usually worked: the second attempt found the page loaded.

OnFlip now checks where it is before it decides what it found. Only your Qwen session, read from Qwen's own page, can say you are signed out.

**A sign-in prompt is no longer taken as proof on its own.** Qwen shows that wording for a signed-out account, for an expired session, and in a promotion offered to people who are perfectly signed in. OnFlip checks your session first, reloads once and sends the message again by itself, and only asks you to sign in when your session really has gone.

**The account bar could show "signed out" on a working account** for the same reason, from a single glance taken before the browser had finished starting. It looks more than once now, and says "could not be read" when that is what happened rather than blaming your account.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.24...desktop-v0.10.25](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.24...desktop-v0.10.25)
