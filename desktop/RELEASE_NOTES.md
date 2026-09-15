# OnFlip Desktop 0.10.37

**"OnFlip could not open the Qwen profile to check the session" — right after signing in.** On a Mac this was close to guaranteed, for a reason that is nobody's mistake: closing a window on macOS does not quit the application.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.37.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.37/OnFlip-Setup-0.10.37.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.37-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.37/OnFlip-0.10.37-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.37-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.37/OnFlip-0.10.37-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in, then being told the profile could not be read.**

Signing in to Qwen or DeepSeek opens a real Google Chrome on a private profile of OnFlip's, because that is the only kind of browser the sign-in providers will accept. OnFlip then opens that same profile itself, to read the session back.

Chrome allows one program at a time to use a profile folder. So if the sign-in Chrome is still running when OnFlip looks, it is refused — and you are told the session could not be checked, having just signed in perfectly well.

**On a Mac that was close to guaranteed.** The instructions say to close the sign-in window once the chat appears, and on macOS closing the last window leaves the application running in the Dock, still using the profile. The same instruction on Windows ends it, which is why this went unseen there.

OnFlip now closes that leftover browser itself before reading — it is a browser OnFlip started, on a folder nothing else has any reason to open — and clears the marker a browser that was force-quit leaves behind.

**And the error message, when one is still needed, is a sentence.** It used to be Chrome's own explanation cut off at 140 characters, which produced, word for word: *"This usually means that the profile is )"*. It now says which browser to quit and — the part that matters on a Mac — that closing the window is not the same as quitting.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.36...desktop-v0.10.37](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.36...desktop-v0.10.37)
