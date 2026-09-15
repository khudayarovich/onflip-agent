# OnFlip Desktop 0.10.26

**Qwen turns that hung for ninety seconds and then said the message never sent.** Two causes, both fixed — one of them mine, from two releases ago.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.26.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.26/OnFlip-Setup-0.10.26.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.26-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.26/OnFlip-0.10.26-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.26-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.26/OnFlip-0.10.26-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**"Qwen did not start answering within 90s" — on a message that never left the box.** Qwen greys out its send button in a way that still looks clickable to OnFlip, so the click landed, the button ignored it, and nothing was sent. OnFlip then waited the full minute and a half before admitting the message had not gone.

It now checks whether the message actually went — Qwen empties the box and shows your message when it does — and tries another way if it did not. A turn that genuinely cannot be sent now says so in a couple of seconds instead of ninety, and says the right thing.

**A turn frozen on "thinking".** Qwen often thinks for a while before writing anything — half a minute is ordinary on a harder question, longer on a slower machine. OnFlip was timing the wait for the *answer*, and thinking produces no answer, so a model that thought for more than ninety seconds was reported as a message that never sent. OnFlip now recognises a page that is working and lets it work.

**If you are on 0.10.24, update.** That release is the one with the send bug; 0.10.25 fixed a separate false "signed out" and this fixes the rest.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.25...desktop-v0.10.26](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.25...desktop-v0.10.26)
