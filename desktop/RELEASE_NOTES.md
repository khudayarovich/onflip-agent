# OnFlip Desktop 0.10.35

**A Qwen turn failing with `net::ERR_ABORTED` before it had really failed.** Reported from a machine running 0.10.33, and caused by a fix in 0.10.33 — the explanation is below rather than buried.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.35.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.35/OnFlip-Setup-0.10.35.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.35-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.35/OnFlip-0.10.35-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.35-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.35/OnFlip-0.10.35-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Turns failing on a navigation that had actually succeeded.**

0.10.33 taught OnFlip to navigate out of Qwen's signed-out guest conversation, which it previously could not leave. That was the right fix and it stays. What it also did was start navigating at a new moment — right after a send — which is precisely when Qwen's own page is navigating itself to the new conversation. The two collide, Chromium reports the request as aborted, and OnFlip took that to mean the browser had gone nowhere.

Usually it had gone somewhere: the page arrives, at the address the site chose, and only the request that asked is marked failed. OnFlip now looks at where the page actually is before believing the failure — the same rule it applies to sessions, applied to navigation.

Connections that genuinely fail — no network, no such host, a real timeout — are unchanged and still reported as failures.

## Still open, and named rather than hidden

**Why a Qwen session ends** after a few hours is not something OnFlip can see. If you are signing in repeatedly, the thing worth ruling out is a second sign-in elsewhere — another machine, or Qwen open in your own browser — since a service that allows one session at a time ends the first when the second begins.

**The signed-out marker added in 0.10.33** was measured against signed-out pages only. If you sign in successfully and OnFlip *still* says signed out, that check is wrong and is worth reporting — the useful test is to sign in and send a message immediately.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.34...desktop-v0.10.35](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.34...desktop-v0.10.35)
