# OnFlip Desktop 0.10.43

**The Arena sign-in window closed itself while Google was still asking for your password. It waits properly now.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.43.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.43/OnFlip-Setup-0.10.43.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.43-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.43/OnFlip-0.10.43-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.43-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.43/OnFlip-0.10.43-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in to Arena closed the window before you could finish.**

0.10.42 said this was fixed. It was not, and it is worth saying exactly how, because the symptom looked identical to the bug it replaced: the window would shut on its own — often within seconds, sometimes with Google's password box still on screen — and afterwards there was no account. Pressing **Sign in** again opened what looked like a brand-new browser, because nothing had ever been saved.

The version before last watched for your account arriving in the profile. The trouble is that everything Arena's sign-in writes shares one name, and the first of those arrives when you *press the button*, two steps before you have an account. Worse, the profile keeps traces of any earlier attempt, so on a second try the check answered "done" the instant the window opened.

It now waits for the thing that only exists once you are actually signed in — the full session, which Arena has to write in two pieces because it is too large for one — and compares against what your profile held before the window opened, so an old attempt cannot be mistaken for a new one. A sign-in that takes you four seconds and one that takes you four minutes both work.

This was found by watching a real sign-in rather than reasoning about it, which is the only reason the second attempt at a fix was not wrong in the same way as the first.

**If the window ever does not close by itself,** it is now harmless: leave it, finish signing in, and press **Done** in OnFlip. That was always the fallback; the automatic close is a convenience on top of it, and it is now built to fail towards leaving your window open rather than towards closing it early.

## Still true from 0.10.41

Arena starts a fresh conversation for every message rather than continuing one thread. It works, and it uses more of your allowance per message than it should. That is still the next thing to improve.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.42...desktop-v0.10.43](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.42...desktop-v0.10.43)
