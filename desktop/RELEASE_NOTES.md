# OnFlip Desktop 0.10.11

**The app stops guessing which service you are on, and your Telegram token stops being world-readable.** Four fixes from a close audit of the shipped 0.10.10 build.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.11.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.11/OnFlip-Setup-0.10.11.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.11-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.11/OnFlip-0.10.11-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.11-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.11/OnFlip-0.10.11-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. Each release now also carries a `SHA256SUMS` file, so you can check a download against it by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**A DeepSeek install no longer says "ChatGPT".** The app learns which service it is on a moment after the window opens, and until then every place that needed a name used the literal "ChatGPT" — right on most installs, wrong on the rest. It now shows no service name rather than the wrong one, and the sign-in window titles itself plainly until it knows what it is signing in to. Small, but it reads as the app being confused about which account you are on, which is worth not doing.

**Your Telegram bot token is no longer readable by other users on the machine.** When a system has no encrypted storage, OnFlip falls back to saving the token in a file — and that file was being created world-readable. It is now written private to you, existing files are corrected on the next save, and the fallback says out loud where the token landed and how to clear it, rather than happening silently.

**Leftover junk in the command allowlist clears itself.** 0.10.10 stopped it being created and ignored what was already there; it is now cleaned from the file at launch too, so it does not survive to confuse a later version.

**Releases publish a checksum.** A `SHA256SUMS` file ships with each build for anyone who wants to verify a download by hand. To be clear about what it is: it lives in the same release as the file it describes, so it is not protection against a compromised release — it catches a corrupted download, or a copy that came from somewhere else. The thing that would close that gap properly is a signed build, which also stops every update clearing your macOS privacy grants.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.10...desktop-v0.10.11](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.10...desktop-v0.10.11)
