# OnFlip Desktop 0.10.6

**Switching services mid-turn can no longer mix them.** Switching to DeepSeek while a ChatGPT turn was still running could leave DeepSeek showing the ChatGPT account's name, with the two services' settings written into each other's space. Fixed at both ends.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.6.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.6/OnFlip-Setup-0.10.6.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.6-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.6/OnFlip-0.10.6-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.6-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.6/OnFlip-0.10.6-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**A service switch during a running turn mixed the two services.** The switch wrote the new service into the settings and restarted the app — but did not stop the agent that was still mid-turn on the old service. For that window, the running agent followed the new service's settings and wrote its own account details into the wrong service's space, which is how DeepSeek could come up wearing the ChatGPT account's name. Now every engine is stopped before the switch is written, and each engine is pinned for its whole life to the service it started on, so no future race of this shape can cross the two. A name misfiled by an older build corrects itself the next time this version reads that service's own account.

One footnote from the same report: DeepSeek's model answering "I am a GPT-4 class model" when asked what it is does not mean your chat went to ChatGPT — DeepSeek's models often mis-identify themselves that way. The account name in the sidebar is the thing to trust, and it is what this release fixes.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.5...desktop-v0.10.6](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.5...desktop-v0.10.6)
