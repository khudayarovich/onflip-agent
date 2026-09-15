# OnFlip Desktop 0.10.36

**Qwen telling you to sign in, right after you signed in.** That was a bug in 0.10.33, it is fixed here, and the explanation is below rather than buried.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.36.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.36/OnFlip-Setup-0.10.36.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.36-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.36/OnFlip-0.10.36-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.36-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.36/OnFlip-0.10.36-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The sign-in loop — signing in, being told you are signed out, signing in again.**

0.10.33 started deciding whether you were signed in to Qwen by looking for the **Log in** button on the page. That was the wrong thing to look at, and the timing is the whole story. Measured on a real page load:

```
1815 ms   the Log in button appears
2561 ms   the server answers: is this session valid?
```

Qwen's page draws its signed-out header **before** it has heard back about your session, then switches once the answer arrives. So a perfectly good session shows *Log in* for about a second on every single load. OnFlip looked after 1.2 seconds — inside that window on any machine that is a little slower — decided you were signed out, and asked you to sign in. Signing in produced the same race the next time.

**OnFlip now asks Qwen directly instead.** There is an endpoint that answers exactly this question, and its reply is unambiguous — with a dead token it returns *"Your session has expired, or the token is no longer valid. Please sign in again to proceed."* A request cannot race a screen being painted, because it is about the session rather than about what has finished drawing.

Reading the page for this is gone entirely rather than kept as a second opinion — keeping it would keep the race — and there is a test that fails if it ever comes back.

If OnFlip cannot reach the service at all, it falls back to what it did before any of this and assumes your session is fine. An outage should cost you a retry, never a sign-in.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.35...desktop-v0.10.36](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.35...desktop-v0.10.36)
