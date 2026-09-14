# OnFlip Desktop 0.10.22

**When DeepSeek says it cannot answer, OnFlip now says so too.** "Messages stuck at sending" turned out to be OnFlip waiting ninety seconds in front of a page that had already explained itself.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.22.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.22/OnFlip-Setup-0.10.22.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.22-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.22/OnFlip-0.10.22-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.22-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.22/OnFlip-0.10.22-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**DeepSeek turns that sat on "sending" and then failed for the wrong reason.** The message went through — the conversation was created, the question was in it — and DeepSeek answered with *"Server busy, please try again later."* OnFlip could not see that, waited a minute and a half for a reply that was never coming, and reported that the send had not landed. It had.

OnFlip now reads the page before waiting the whole window out, and tells you what DeepSeek actually said, word for word. It also knows what each one means: **busy** is worth trying again, a **verification page** is something only you can clear, and a **rate limit** waits rather than pushing. Chinese wording is recognised as well as English, since the site ships in both.

If DeepSeek is having a bad day — and it is mid-rollout of a new model this week — you will now see that in a few seconds instead of after ninety.

**Long command output is kept instead of thrown away.** A build or a test run whose output is too big for the conversation was cut down to fit, and the middle was simply lost — the only way to see it again was to run the command a second time. The whole output is now written to a file first, and the cut says where to find it.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.21...desktop-v0.10.22](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.21...desktop-v0.10.22)
