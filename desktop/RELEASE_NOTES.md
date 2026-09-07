# OnFlip Desktop 0.10.4

**The DeepSeek sign-in you completed now counts.** Successful sign-ins were being reported as failures on Windows and macOS alike — fixed, and the sign-in window now closes itself the moment the session lands, the way ChatGPT's does. Plus Allow once / Deny buttons right on the Windows approval toast, and the find-in-chat bar has its height back.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.4.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.4/OnFlip-Setup-0.10.4.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.4-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.4/OnFlip-0.10.4-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.4-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.4/OnFlip-0.10.4-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in to DeepSeek works.** The sign-in itself always did — the app then threw the success away, expecting a detail only the ChatGPT flow reports, and the dialog dropped back with no message as though nothing had happened. If you signed in before this fix and gave up: your session is very likely already in the app's profile, and 0.10.4 will simply find it — check the account menu before signing in again.

**The DeepSeek sign-in window closes itself.** Sign in, and the window is closed for you the moment the session reaches the profile — no more closing it by hand or hunting for the Done button. The window is also closed the way Chrome's own Quit closes it, and the app waits for it to be truly gone before checking, so a session can no longer be lost to a race with the browser writing it out.

## What's new

**Answer approvals from the toast (Windows).** When OnFlip needs your approval while you are in another window, the notification now carries **Allow once** and **Deny** buttons — answer without switching apps, and the window stays where it is. Answering in the app, or from Telegram, takes the toast down so nobody is left holding live buttons for a settled question.

## Also fixed

**Find in chat had been squashed flat** — the search bar now renders at its full height.

**Two more ways a turn could spend its whole step budget on nothing are closed.** On a machine with no usable browser, the first failed browser start is now the answer for the session instead of being retried at full cost; and after the conversation is compacted, the model gets its tool roster and a worked example back — the moment a session in the field fell off the protocol and refused its way to the step limit.

Everything here works the same on ChatGPT and DeepSeek.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.3...desktop-v0.10.4](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.3...desktop-v0.10.4)
