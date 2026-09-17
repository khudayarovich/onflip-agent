# OnFlip Desktop 0.10.48

**When Arena asks for a captcha, the browser window now comes to you — click it once and the turn carries on by itself.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.48.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.48/OnFlip-Setup-0.10.48.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.48-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.48/OnFlip-0.10.48-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.48-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.48/OnFlip-0.10.48-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Arena's security verification killed the turn instead of asking you.**

Cloudflare sometimes puts a *"Verify you are human"* captcha in front of an Arena message — more often on some networks than others. OnFlip read that challenge as a refusal and failed the turn, which was the worst possible reading: a captcha is precisely the one thing in the whole pipeline that needs a person, and the person is right there.

Now, when a challenge appears at any point in a turn — before the send, on the click itself, or while an answer is being written — OnFlip brings the Arena browser window onto your screen, waits for you to click the checkbox, and then carries on by itself: the held message is re-sent, the reply is picked up, and on Windows the window parks itself back off the desktop. If the checkbox goes unclicked for four minutes, the turn fails with instructions instead of a bare error.

You should only need to click it once in a while — the clearance Cloudflare grants is kept in Arena's browser profile.

**Being straight about Arena.** It is the most automation-hostile of the four services, and Cloudflare's decision to challenge you depends on your network, not on this app. If Arena demands a captcha on every single message even after you click one, that is Arena's policy working as intended — Qwen and DeepSeek remain the dependable free services, one switch away in the account menu.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.47...desktop-v0.10.48](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.47...desktop-v0.10.48)
