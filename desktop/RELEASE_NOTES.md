# OnFlip Desktop 0.10.34

**Every service now asks whether your session is real, instead of assuming it from a token.** 0.10.33 fixed that for Qwen. DeepSeek had the identical fault, ChatGPT had a version of it, and this closes the last four findings from the external audit.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.34.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.34/OnFlip-Setup-0.10.34.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.34-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.34/OnFlip-0.10.34-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.34-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.34/OnFlip-0.10.34-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**DeepSeek could report itself connected on a session that had ended.** Exactly the fault 0.10.33 fixed for Qwen: the token stays in the browser after the service stops honouring it, OnFlip read the token, and the sends failed.

What makes this one worth telling you about is that the answer was already being fetched. OnFlip asks DeepSeek who you are in order to put your name in the sidebar — and it was throwing away everything else that request said, so "your session is over" arrived and was discarded alongside an ordinary network hiccup. It is the verdict now. Only DeepSeek actually refusing the session counts as signed out; an outage or a timeout means *could not find out*, and never costs you a sign-in.

**ChatGPT kept saying "connected" through every failed turn.** When a turn fails because the session has gone, OnFlip already notes it — and then reported connected anyway, because a cookie was still sitting in the jar. Holding a cookie is not holding a session: the jar keeps what it was given, and one the service has stopped honouring looks exactly like one it still accepts. Having actually looked and found nothing now counts for more than something merely being present.

**Qwen's retry sent into a second dead chat before telling you.** When a message landed in a guest conversation, OnFlip reloaded and sent again without checking whether it had got anywhere — so a session that really had ended cost you another wait before anything was said. It checks first now.

**Cookies crossed between hosts.** OnFlip reads your ChatGPT session from two of OpenAI's hostnames and kept only names and values, then sent the whole lot to whichever it was talking to. Nothing went to a stranger — both are OpenAI — but a cookie set for one host is not ours to hand to another. Sessions saved by older versions keep working exactly as before.

**The Browser pane can be switched off.** It runs over a local debugging port, and anything else on your machine can reach that port — it cannot be locked, because the port *is* the feature. It was only closable with an environment variable, which is not a control anyone can find. It is in Settings now, on by default. Worth turning off on a computer other people have accounts on; it takes effect after a restart.

**The macOS build stops declaring that any connection is acceptable.** Electron ships that permission by default and OnFlip has no use for it. Being straight about the size of this: most of what the app does goes through Chromium's own networking, which ignores the setting — it removes a claim, it does not add a wall. Local addresses stay allowed, so `localhost:3000` in the address bar still works.

## Still open, and named rather than hidden

Two things this cannot tell you yet. **Why a Qwen session ends** after a few hours is not something OnFlip can see — if you sign in repeatedly, the thing to rule out is a second sign-in elsewhere, since a service allowing one session at a time ends the first when the second begins. And the signed-out marker added in 0.10.33 was measured against signed-out pages only; if you sign in successfully and OnFlip still says signed out, that check is wrong and is worth reporting.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.33...desktop-v0.10.34](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.33...desktop-v0.10.34)
