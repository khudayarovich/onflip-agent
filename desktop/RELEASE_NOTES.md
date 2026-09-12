# OnFlip Desktop 0.10.9

**DeepSeek starts as DeepSeek.** Quitting and reopening the app on DeepSeek could bring it back showing the ChatGPT account, and then leave a message sitting at "sending". Fixed at the root: a DeepSeek run no longer starts ChatGPT's browser behind your back.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.9.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.9/OnFlip-Setup-0.10.9.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.9-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.9/OnFlip-0.10.9-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.9-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.9/OnFlip-0.10.9-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**A message no longer sits at "sending" on DeepSeek.** On startup OnFlip asks the account for its list of models when it has none saved — and that question is ChatGPT's, asked through ChatGPT's own browser. On DeepSeek it was still being asked. DeepSeek's three modes are a fixed list that is never looked up, so the call did nothing useful, opened the wrong service's browser, and — because startup waits for it — could hold the whole engine short of ready while a ChatGPT page loaded or was challenged. A message sent in that state simply waits. DeepSeek never touches ChatGPT's browser now, and starts noticeably quicker for it.

**DeepSeek stops showing the ChatGPT account.** The account name is remembered between launches so the sidebar is not blank while it loads, but it was only ever checked when nothing was remembered — so a name written into the wrong service's settings by an older version stayed on screen through every restart. The remembered name is now checked against the service itself once per run, and corrected. It repairs itself the first time you complete a turn on this version, with nothing to reset by hand.

**And the leftovers behind both.** An older version could file ChatGPT's model list into DeepSeek's settings; it is now ignored on sight and cleared out the next time anything is saved. This is the last of the damage from that bug — 0.10.6 stopped it happening, and this clears what it left.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.8...desktop-v0.10.9](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.8...desktop-v0.10.9)
