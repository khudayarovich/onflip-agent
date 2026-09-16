# OnFlip Desktop 0.10.44

**The Arena sign-in window was telling Google it was automated. Google acts accordingly.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.44.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.44/OnFlip-Setup-0.10.44.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.44-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.44/OnFlip-0.10.44-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.44-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.44/OnFlip-0.10.44-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Signing in to Arena kept failing, and the browser said why.**

If you saw a yellow bar reading *"You are using an unsupported command-line flag"* across the sign-in window, that bar was the whole story. The window was being launched with a flag that belongs to OnFlip's automated browser — the one that drives Arena's chat page — and that flag marks a browser as automated. Google refuses to complete a sign-in from a browser it reads that way, which is exactly why OnFlip opens a separate, ordinary Chrome for signing in at all.

So the sign-in could not succeed, no account was ever saved, and every attempt started from a browser that remembered nothing. The window now launches with the same plain flags a person's own Chrome uses — the same ones the DeepSeek and Qwen sign-ins have always used — and a test now holds all three services to it, so no service added later can borrow its driver's flags again.

**The sign-in window opened on a page with no sign-in button.**

Arena keeps **Log In** inside its sidebar, and the sidebar starts collapsed — the button is not on the chat page at all until the sidebar is opened. The sign-in dialog in OnFlip now tells you where to look: open the sidebar with the button at the top left of that window, then choose **Log In**.

## From 0.10.43, and still true

The detection that closes the sign-in window for you now waits for the *finished* session — the cookie Arena writes only once an account has actually arrived — compared against what the profile held before the window opened. If the window ever does not close by itself, leave it, finish signing in, and press **Done** in OnFlip; that path always works.

## Still true from 0.10.41

Arena starts a fresh conversation for every message rather than continuing one thread. It works, and it uses more of your allowance per message than it should. That is still the next thing to improve.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.43...desktop-v0.10.44](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.43...desktop-v0.10.44)
