# OnFlip Desktop 0.10.8

**macOS can import a browser session again, the model on screen is the one that is running, and Settings opens in front of the browser instead of behind it.** Plus more room to work: turns get a larger step budget, and DeepSeek keeps far more of the conversation before compacting.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.8.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.8/OnFlip-Setup-0.10.8.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.8-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.8/OnFlip-0.10.8-mac-arm64.dmg) | ~106 MB |
| **macOS** · Intel | [OnFlip-0.10.8-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.8/OnFlip-0.10.8-mac-x64.dmg) | ~113 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**macOS: a signed-in browser is found again.** Reported from a Mac with Firefox logged in to ChatGPT, where OnFlip asked for a sign-in anyway. The reader never reached the cookies: the piece that opens a browser's cookie database is compiled per runtime, and only the Windows build was ever packaged — so on a Mac it had nothing to load and every browser failed the same way. Both macOS architectures now ship theirs. And when a runtime genuinely cannot load it, OnFlip now tries the next one instead of reporting "no session found", and says plainly that it is a packaging problem rather than a missing login.

**The model shown is the model running.** Opening a session recorded on one service while the other was running adopted that session's model — so DeepSeek could sit there displaying a `gpt` model it has never heard of, while quietly running its own default. The label and the run now always agree. Sessions carrying the wrong model correct themselves the first time you open them on this version.

**Settings no longer opens behind the built-in browser.** The browser panel is a real browser view the system draws on top of the window, which no amount of layering in the app could cover. Any dialog now moves it aside and puts it back afterwards.

## What's new

**Turns get further before stopping.** The step budget goes from 40 to 100. It exists to stop a turn spending your account on nothing, and 40 was cutting real work short about as often as it caught a runaway — a build, a test run and a couple of fixes is dozens of steps before anything has gone wrong. A turn that is genuinely spinning still stops exactly where it did.

**DeepSeek keeps much more of the conversation.** Its compaction point moves from 45,000 to 150,000 characters. DeepSeek's composer takes it and nothing on that path silently truncates, so sessions there hold their thread far longer. ChatGPT stays where it is: a single message over ~80,000 characters is cut in the middle by the service, so a larger setting there would lose the middle of long conversations rather than keep them.

**A clearer diagnostics line** — the report no longer says "uploads unavailable" when what it means is that large turns are typed rather than sent as a file. Attaching files was never affected.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.7...desktop-v0.10.8](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.7...desktop-v0.10.8)
