# OnFlip Desktop 0.10.40

**A turn that sat on "sending" for ever, and the answer to why a Qwen session ends while you are still using it.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.40.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.40/OnFlip-Setup-0.10.40.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.40-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.40/OnFlip-0.10.40-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.40-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.40/OnFlip-0.10.40-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Turns that stopped on "sending" and never moved again.**

Everything OnFlip asks a web page — read the reply, fill the box, press send, check it went — is a small script run inside that page, and those have no time limit of their own. Five of them had none applied. If the page stalled while one was running, OnFlip waited for it with no deadline and nothing in the log.

Three of the five ran *before* the reply clock started, which is the version you would have seen: stuck on "sending", not on "thinking", with no eventual failure and no explanation. Every one of them is now bounded, and a test walks the code to keep it that way — it is what found these, so it is also what stops the next one.

**Messages from the service in your own language went unread.** Every one of these drivers decides what to do from words on the page — a login wall, a bot check, a rate limit, an overloaded server — and those words were only ever matched in English, with Chinese added for the two Chinese services. Qwen alone is available in seventeen languages.

That is not cosmetic. A login wall OnFlip cannot read becomes ninety seconds of silence and a wrong explanation, instead of "sign in". A rate limit it cannot read becomes a retry that makes it worse. Russian is now recognised by all three, taken from Qwen's own translation files rather than translated by hand.

## Answered

**Why a Qwen session ends after a few hours, with weeks left on it.**

Qwen hands the browser a *new* session token every time it answers, and the previous one stops working — its own refusal says as much: "expired, **or the token is no longer valid**". So the session belongs to whichever browser used it last. Open Qwen in an ordinary browser, on your phone, or on another computer, and OnFlip's session ends — not because anything went wrong, but because the service moved it.

OnFlip cannot prevent that, and this release does not pretend to. What it does now is say so: when a Qwen session ends, the message names this as the likely reason instead of just asking you to sign in again. If you want a long-running session here, keep that account to this app while it is working.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.39...desktop-v0.10.40](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.39...desktop-v0.10.40)
