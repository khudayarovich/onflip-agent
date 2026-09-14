# OnFlip Desktop 0.10.18

**DeepSeek merged its three modes today, and OnFlip went on offering all three.** Choosing one did nothing — quietly. That's fixed, and OnFlip now watches the page so the next time a service moves something, you hear about it.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.18.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.18/OnFlip-Setup-0.10.18.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.18-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.18/OnFlip-0.10.18-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.18-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.18/OnFlip-0.10.18-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The DeepSeek model picker offered three choices that all did the same thing.** On 14 September 2026 DeepSeek unified Instant, Expert and Vision into one model. The control OnFlip clicked to choose between them is gone from the page — checked on the live page, not taken from the announcement. OnFlip kept showing all three, and picking one reached for a control that no longer existed and gave up without saying so.

There is now one DeepSeek model. If you had picked Instant, Expert or Vision, that setting opens the model that replaced all three rather than pointing at a name nothing answers to. **The Expert behaviour moved to the Thinking setting**, which drives DeepThink on the page and still works exactly as before.

## New

**OnFlip watches the service's page and tells you when it changes.** This is the general version of the bug above, and it is the one worth having: ChatGPT and DeepSeek redesign their own pages whenever they like, and the damage is silent by nature — a click that finds nothing does nothing, and nothing is reported.

Every control OnFlip drives is now written down as a contract: the message box, the send button, the DeepThink toggle, the attachment input, where a reply is read from. Each one says whether it should be there. A control that should be present and is missing is a break. A control that was retired and comes back is also news, because it means a choice exists again that OnFlip is not making.

It runs by itself once per launch, on the first turn, using the page that is already open — so it costs nothing a turn was not already paying, and it can never make a send fail. What it finds appears on the **Health** page as *page controls missing*, and there is a button there to run the deeper check whenever you want an answer now — the one that opens the service's own page and looks.

If that number is ever not zero, something moved and OnFlip needs a fix. That is the point: you find out from the app instead of from a picker that quietly does nothing.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.17...desktop-v0.10.18](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.17...desktop-v0.10.18)
