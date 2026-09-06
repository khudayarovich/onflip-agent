# OnFlip Desktop 0.10.1

**Answers come back in the language you wrote in.** Ask in English on a Russian machine and the reply used to arrive in Russian — reproduced on a brand-new chat, first reply. Fixed, along with a DeepSeek sign-in that reported no session on a new PC when it had one, and queued messages you can now edit or delete. Everything in [0.10.0](https://github.com/khudayarovich/onflip-agent/releases/tag/desktop-v0.10.0) — DeepSeek as a second service — is unchanged.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.1.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.1/OnFlip-Setup-0.10.1.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.1-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.1/OnFlip-0.10.1-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.1-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.1/OnFlip-0.10.1-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The reply came back in the wrong language.** An English question, a Russian answer — on a brand-new chat, on the first reply, with nothing in the conversation to drift from. OnFlip was already quoting the question back to the model every turn, so the pull was coming from outside the conversation: the account's own language preference, which reaches the model first and which OnFlip can neither read nor change. Against a standing preference, "write in the language of this message" is soft enough to satisfy both readings, so the reminder now also says what the message is *not* — a message with no Cyrillic in it is not Russian, stated outright. A Russian question still gets a Russian answer, and Uzbek is never mistaken for English: script is the one thing that can be decided without guessing, and the quote carries the rest.

**Signing in to DeepSeek on a new machine said there was no session.** There was one — quitting and reopening found it. Playwright's first launch on a profile a real Chrome has just created loses its connection when Chrome relaunches itself, and every way of failing to open the profile was being reported as "not signed in", which sends you to sign in again to fix something a sign-in cannot fix. The check now retries, fails fast enough for retrying to be worth it, and says what actually went wrong. A sign-in window that Chrome hands to another process no longer counts as you closing it.

**Six labels named ChatGPT while running DeepSeek** — including the sign-out confirmation, which is the worst place to name the wrong service. The delete-session prompt also promised to remove ChatGPT conversations that DeepSeek does not have.

## What's new

**Queued messages can be taken back.** A message sent behind a running turn used to be committed — it sat in the strip with no way to change it, and the only control was clearing the whole queue. Each one now has its own controls: edit it back into the composer, attachments and all, or drop it.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key.

**Full changelog:** [desktop-v0.10.0...desktop-v0.10.1](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.0...desktop-v0.10.1)
