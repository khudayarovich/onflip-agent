# OnFlip Desktop 0.10.19

**ChatGPT's page is watched too now.** 0.10.18 started checking DeepSeek's page for the controls OnFlip drives, so a silent redesign shows up as a number instead of as a feature that quietly stopped working. ChatGPT was left on a button because its check opened a page of its own. It doesn't have to.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.19.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.19/OnFlip-Setup-0.10.19.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.19-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.19/OnFlip-0.10.19-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.19-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.19/OnFlip-0.10.19-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Changed

**The page check now runs on ChatGPT as well, by itself.** It uses the conversation a turn has just finished with, so it costs one look at a page that is already open — no second tab, no navigation, and it can never make a send fail. Once per launch, and what it finds lands on the **Health** page as *page controls missing*, the same as DeepSeek's.

The timing is deliberate: it looks *after* a reply, when the conversation is at its richest. That is what lets the important entries be required rather than hopeful — a reply has just been read through the very selectors the check counts, so they cannot read zero on a page where the turn worked unless something genuinely moved.

Everything that is legitimately empty on an ordinary page stays optional: attachments are off by default, a fresh conversation has no turns of yours in it yet, and a notice from the site is the exception rather than the rule. A check that reports a problem when there isn't one teaches you to ignore it — and then the real one arrives and gets ignored too.

If that number is ever not zero, a service moved something and OnFlip needs a fix. You find out from the app.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.18...desktop-v0.10.19](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.18...desktop-v0.10.19)
