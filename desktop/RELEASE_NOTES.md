# OnFlip Desktop 0.10.46

**Arena answers now. Its first reply was sitting behind three dialogs and a silent mode switch that only a brand-new session ever met.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.46.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.46/OnFlip-Setup-0.10.46.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.46-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.46/OnFlip-0.10.46-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.46-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.46/OnFlip-0.10.46-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Arena messages stuck at "sending" forever, with no reply.**

Signing in was fixed in 0.10.45 — and then the first message hung. The cause was everything Arena puts in front of a *new* session, none of which an established one ever sees again, which is why it never reproduced on the machine the provider was built on:

- **The first press of Send does not send.** It opens Arena's Terms of Use dialog and holds your message — invisibly, in the windowless browser. OnFlip now answers that dialog, waits for the held message to go, and presses Send again itself if Arena does not let it go on its own.
- **New sessions start in Battle Mode**, where two anonymous models answer and OnFlip can read neither. The switch to Direct mode had quietly stopped working — Arena rebuilt its menus — and a cold first page-load ignores the first click besides. The switch works again, retries on a slow page, and is only believed once the control actually says "Direct".
- **Arena has put Direct mode behind an account.** Signed out, a "Log In or Create Account" dialog appears where the answer would be. OnFlip cannot change that rule, so it now tells you plainly to sign in instead of waiting forever.

Also observed while verifying: Arena's own *"Something went wrong while generating the response"* on turns that had worked minutes earlier. OnFlip detects and reports that error — if you see it, that one is Arena's weather, not the app.

**Updates were offered before their files existed.** A release appears on GitHub minutes before its installers finish uploading, and in that window the update button could only open a release page with the file missing. The offer now waits for your platform's installer *and* its checksum list; until then a check answers "still being published — try again in a few minutes".

**The About page's update button opened GitHub every time.** It now downloads, verifies and installs in place, exactly like the update banner, with the release page kept only as a fallback.

## Changed

**Sub-tasks are now off by default.** A sub-task runs in a conversation of its own, which spends more of your account's allowance — that is now a cost you choose in Settings rather than inherit. If you had already turned it on, it stays on.

## Worth knowing

DeepSeek taking ~20 seconds to answer is the service thinking, not the app: measured through OnFlip, the first characters of a reply arrive about 3–4 seconds after Send even on very long turns.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.45...desktop-v0.10.46](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.45...desktop-v0.10.46)
