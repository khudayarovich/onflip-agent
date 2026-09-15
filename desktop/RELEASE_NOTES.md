# OnFlip Desktop 0.10.30

**The Qwen sign-in loop.** Sign in, the window shuts before you can type, the app says you are signed in, the next message goes nowhere, and it asks again. Fixed.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.30.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.30/OnFlip-Setup-0.10.30.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.30-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.30/OnFlip-0.10.30-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.30-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.30/OnFlip-0.10.30-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in to Qwen went round in circles.** The window opened and closed again within a couple of seconds, OnFlip reported you signed in, and the next message went nowhere — then it asked you to sign in again.

OnFlip closes that window for you as soon as your sign-in reaches the browser profile, so you do not have to press a button as well. It was checking whether a sign-in token was present, on the assumption that a signed-out profile has none. Qwen does not work that way: it leaves the expired token behind, looking perfectly valid. So on any profile whose session had lapsed, OnFlip decided you had signed in the instant the window appeared — and closed it in your face.

It now waits for a token that was **not there before**, so the window stays open until you have actually signed in. And finishing without signing in — cancelling, or closing the window — is no longer mistaken for success on the strength of the old token.

<i>If Qwen has been asking you to sign in repeatedly: update, then sign in once more. It will hold this time.</i>

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.29...desktop-v0.10.30](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.29...desktop-v0.10.30)
