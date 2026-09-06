# OnFlip Desktop 0.10.3

**The agent knows when you are asking from your phone.** Ask over Telegram for a file and the file arrives, instead of the path to it. Plus a turn that can no longer spend itself retrying one thing that cannot work, and the bot showing three dots while it thinks.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.3.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.3/OnFlip-Setup-0.10.3.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.3-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.3/OnFlip-0.10.3-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.3-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.3/OnFlip-0.10.3-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

**A request from Telegram now says so.** Asked over the bot to send a file, the agent used to save it and answer with its path — the right answer for someone at the keyboard, and no answer at all for someone holding a phone, who then had to ask a second time. The turn now carries where it came from: the model is told the person is not at this computer, cannot open a path on it, and that anything they asked for goes to them as a file. Answers from the bot are kept short enough to read on a phone. A request typed at the desktop is unaffected — there a path is exactly right.

**The bot shows it is thinking.** Three dots in the chat header for as long as the turn runs, refreshed every four seconds, gone the moment it ends. An agent turn is minutes, and the gap between "Working…" and the answer used to look like nothing happening.

## Fixed

**A turn can no longer spend itself on one thing that cannot work.** From a real log: a Word document to export as PDF, on a machine where Word's COM export never returned. The agent tried it four ways — direct export, a retry wrapper, LibreOffice, SaveAs — each killed at the two-minute limit, and each attempt made the next worse, because killing a command does not kill the Word process it started and that process kept the document open. Identical-call detection could not see it: four spellings of one idea are not the same call. Timeouts are counted on their own now, and from the second one the model is told what it actually needs — that a timeout is a command that never came back, that whatever it started is still running and still holding its files, and to take a different route or stop and say what is blocking it.

**PowerShell parse errors are no longer unreadable.** They are written before the command runs, so the prelude that switches the console to UTF-8 has not executed and they arrive in the wrong codepage as a drift of replacement characters. A model that cannot read its own syntax error cannot fix it, so it guesses — which is how the loop above began. Those are now recognised and flagged as unreliable text.

**And the syntax error itself:** a here-string whose closing `'@` was indented with the rest of the script. That is a parse error every time, and writing a script inside an indented block is exactly the situation that produces it, so the shell tool now says the rule out loud — along with the one about Office applications outliving the command that opened them.

Everything here works the same on ChatGPT and DeepSeek.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.2...desktop-v0.10.3](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.2...desktop-v0.10.3)
