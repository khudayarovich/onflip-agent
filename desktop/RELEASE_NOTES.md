# OnFlip Desktop 0.10.13

**Two fixes found by auditing the last release.** Writing a document with a here-document no longer fills your approved-commands list with the words in it, and the last place that guessed "ChatGPT" when it did not know the service is gone.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.13.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.13/OnFlip-Setup-0.10.13.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.13-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.13/OnFlip-0.10.13-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.13-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.13/OnFlip-0.10.13-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Writing a file no longer adds its contents to your approved commands.** When the agent writes a document by piping text into a file — the ordinary way a shell does it — OnFlip was reading every line of that text as another command you had just approved. One install ended up with 112 approved "commands" that were really words out of a document: `five`, `each`, `appreciated.`, `0.10.10`. Harmless in themselves, but the list is meant to be things you decided to trust, and it had stopped being that.

The text is now skipped entirely rather than parsed. That has to be the fix, because there is no way to tell `five` from a real command by looking at it — it is a perfectly plausible program name.

**If your list already grew this way**, it cannot be cleaned up automatically for the same reason. Deleting the `allowedCommands` line from `~/.onflip/config.json` is safe and is the quickest fix — it only means approving those commands once more.

**The last "ChatGPT" guess is gone.** 0.10.11 stopped the account bar naming the wrong service, but there turned out to be a second place doing the same thing behind the sign-out prompt and a settings line, so an unrecognised service still read as ChatGPT. There is now one piece of code that names the service, and it never invents one: the service when it knows, the name as given when it does not recognise it, and nothing at all before it knows.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.12...desktop-v0.10.13](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.12...desktop-v0.10.13)
