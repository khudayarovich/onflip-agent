# OnFlip Desktop 0.10.31

**Qwen turns that failed saying your session had expired — when it had not.** 0.10.30 was too quick to give up; it now tries again first.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.31.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.31/OnFlip-Setup-0.10.31.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.31-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.31/OnFlip-0.10.31-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.31-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.31/OnFlip-0.10.31-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**"The session has expired" on a session that was working.** The previous release learned to spot when Qwen drops the browser into a signed-out guest chat — and then treated it as final. It is not: messages kept going through in between the failures, which an expired session cannot do.

OnFlip now does what you were doing by hand — reloads and sends it again — and only tells you the session has expired if the guest chat survives that. When it really has expired you are told in about five seconds rather than ninety.

**A likely cause of the guest chat itself, reduced.** When OnFlip opens a fresh Qwen chat it used to wait a flat two seconds before typing. On a slower machine that is not always long enough for Qwen to apply your sign-in to the page, and a message sent a moment too early is treated as a message from a signed-out visitor — which Qwen accepts and never answers. It now waits for the message box to appear rather than for a fixed count.

<i>If Qwen is showing the Sign in button: sign in. 0.10.30 fixed the window that used to close itself before you could, so it will hold now.</i>

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.30...desktop-v0.10.31](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.30...desktop-v0.10.31)
