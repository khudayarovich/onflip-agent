# OnFlip Desktop 0.10.32

**An outside audit read the shipped build and found thirteen things. Eleven are fixed here.** Most of them are about one question: what is OnFlip allowed to do, and on whose say-so.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.32.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.32/OnFlip-Setup-0.10.32.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.32-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.32/OnFlip-0.10.32-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.32-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.32/OnFlip-0.10.32-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand, and from this release the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Changed — read this part

Three things behave differently on purpose. If one of them was how you worked, it will look like a fault.

**The Telegram bot answers in private chats only.** It used to reply in groups it had been added to, and any group that had ever spoken to it became a destination for every later answer, tool output, file and permission prompt — including after you removed the person who introduced it. Groups stored by an older build are dropped when this one starts. Message the bot directly.

**"Always allow" now means that exact command.** Approving `python train.py` used to store `python`, and every `python` command afterwards ran without asking — including `python -c` with anything in it. It remembers what you approved, character for character. You will be asked more often at first; a whole class of commands is still available as a rule you write down deliberately.

**Full access is off on macOS.** `Full access` and `No approvals` are no longer offered in the access menu, in the app or over Telegram, and a Mac that was left in one comes back up in `Ask`. Those two modes send the model's output straight to the shell with only a list of patterns in the way, and that list cannot see through an interpreter, a package manager, or a script the model has just written. The plain version: the risk is not specific to macOS — it is the same on Windows, where the modes remain. What is specific is that the Mac is the machine running unattended from a phone, with nobody watching the screen. Set `ONFLIP_ALLOW_FULL_ACCESS=1` to put them back.

## Fixed

**A service could report itself signed in because a different service was.** OnFlip resolved ChatGPT credentials on every start no matter which service was selected, and then answered "signed in" on the strength of a ChatGPT cookie. Select DeepSeek, be signed out of it, have ChatGPT signed in on the same machine, and the app said you were connected — then the first message failed. Each service answers for itself now.

**Signing out of one service signed you out of another.** Sign-out cleared the ChatGPT browser session whichever service you were leaving, so leaving DeepSeek quietly signed you out of ChatGPT. The sign-in button had the mirror-image bug: it always logs into chatgpt.com, and filed the result under whatever service happened to be active.

**Permission prompts could be answered by the wrong window.** If you had two OnFlip windows open, a prompt raised in one could be settled from the other. Each prompt now belongs to the window that was asked.

**The updater checked the download's length and nothing else.** Every release already published a `SHA256SUMS` list that nothing read. It is checked before anything is unpacked, and a mismatch refuses to install. Said plainly: the list sits beside the file it describes, so this is no defence against a compromised release — it catches a download that arrived truncated, corrupted or swapped in transit. Real protection there needs a signing certificate this project does not yet have.

**A write inside your project folder could land outside it through a symlink.** The containment check compared paths as text while the write followed the link.

**OnFlip's own folders were readable by every account on the machine.** Created and repaired at owner-only permissions.

**The built-in browser's address bar accepted more than addresses.** `file:`, `data:`, `blob:`, `view-source:`, `chrome:` and `devtools:` all worked. None is something a person types into an address bar, and all of them are reachable by talking somebody into pasting one. It navigates the web now.

**Qwen sessions that had already expired.** The token carries its own expiry, and reading it costs nothing — so the one case that can be settled without asking Qwen is settled before the message is sent, rather than discovered ninety seconds later. This is the local half of it; the service still has the final say.

## Not fixed, and not pretended otherwise

Four of the thirteen are still open, each for a stated reason rather than an oversight: the cookie jar's scoping, the debugging port the Browser pane attaches through, session checks that need a provider endpoint to call, and one macOS network setting whose effect could not be tested from a Windows machine. They are written down in the commit beside the fixes.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.31...desktop-v0.10.32](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.31...desktop-v0.10.32)
