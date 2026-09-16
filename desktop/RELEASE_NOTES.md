# OnFlip Desktop 0.10.45

**The Arena sign-in and the browser that checks it were encrypting the profile with two different keys. On a Mac, each erased the other's work.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.45.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.45/OnFlip-Setup-0.10.45.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.45-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.45/OnFlip-0.10.45-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.45-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.45/OnFlip-0.10.45-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in to Arena on a Mac could never stick — the account was erased in the act of checking for it.**

This is the fault that has been underneath every Arena sign-in report, and it only exists on macOS, which is why release after release worked on the Windows machine it was tested on and failed on a Mac.

Arena is the first service in OnFlip whose session lives in browser cookies. Cookie values are encrypted on disk, and on a Mac the encryption key depends on *how the browser was started*: the window you sign in through used the real system Keychain, while the automated browser that drives Arena — and checks whether you signed in — runs with a stand-in key, as automated browsers do so they never touch your Keychain. Two keys, one profile. The checker could not decrypt the session you had just created, and a browser discards cookies it cannot decrypt — so it reported no account *and threw the session away*, and its own cookies were unreadable to the next sign-in window in turn. Every attempt genuinely started from nothing.

The other services never showed this because their sessions are stored as tokens, not cookies, and tokens are not encrypted this way. Windows never showed it because it encrypts cookies identically for both launches.

Both browsers now use the same key. Signed in stays signed in.

**One thing to expect the first time:** your Arena profile still holds cookies under the old key, so the first sign-in after this update starts fresh once — including Google asking you to sign in again. Do it once more; from then on it holds.

## Also in the recent fixes, and still true

The sign-in window opens with plain, ordinary browser flags (0.10.44 — if you ever saw a yellow "unsupported command-line flag" bar, it is gone). Arena keeps its **Log In** button inside the sidebar, which starts collapsed — open the sidebar with the button at the top left of that window. If the window does not close by itself after you finish, leave it and press **Done** in OnFlip; that path always works.

## Still true from 0.10.41

Arena starts a fresh conversation for every message rather than continuing one thread. It works, and it uses more of your allowance per message than it should. That is still the next thing to improve.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.44...desktop-v0.10.45](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.44...desktop-v0.10.45)
