# OnFlip Desktop 0.10.47

**Arena answers now — for real this time. Arena had started silently killing every reply requested by a windowless browser, and OnFlip's browser was windowless.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.47.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.47/OnFlip-Setup-0.10.47.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.47-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.47/OnFlip-0.10.47-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.47-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.47/OnFlip-0.10.47-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Arena messages still hung at "sending" and "thinking" after 0.10.46 — and this time the cause was measured with the shipped app itself.**

Arena has started killing replies requested from a headless browser, silently and at the last moment: it accepts the message, shows "Generating…", and then fails the generation server-side with its own *"Something went wrong while generating the response."* The same message, from the same signed-in account, minutes apart: headless died every single time, and a browser with a real window answered in twenty seconds. That silence at the end is why it looked like OnFlip hanging rather than Arena refusing.

Two changes:

- **OnFlip now drives Arena with a real browser window — parked far off your desktop**, where you cannot see it. Verified invisible on Windows; on a Mac the system may nudge the window somewhere visible, in which case the worst you get is a Chrome window you can see and working answers. Not touching it is fine.
- **When Arena does kill a reply, you hear about it in seconds, not minutes.** Its error appears in the chat as *"Arena says: Something went wrong…"* almost immediately, instead of three minutes of "still working" per attempt. If you see that message, it is Arena's weather — wait a moment and retry.

Everything 0.10.46 fixed still stands: the Terms-of-Use dialog on a session's first message is answered for you, the Direct-mode switch works against Arena's rebuilt menus, and a signed-out session that hits Arena's new login wall is told to sign in rather than left waiting.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.46...desktop-v0.10.47](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.46...desktop-v0.10.47)
