# OnFlip Desktop 0.10.15

**A DeepSeek turn that could have been retried no longer ends.** Four turns in one week's logs died on a failure that the app was allowed to try again — and never did, because of the way the message was worded.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.15.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.15/OnFlip-Setup-0.10.15.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.15-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.15/OnFlip-0.10.15-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.15-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.15/OnFlip-0.10.15-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**DeepSeek turns that stopped instead of trying again.** When a message went into DeepSeek and no answer started, OnFlip said *"the page may have signed out, or the send did not land"* and ended the turn. The retry was not failing — it was never attempted. OnFlip decides whether a failure is worth retrying, and for this one it decided by reading its own sentence, where the words "signed out" appear inside a hedge about what might have happened. A turn that was one resend away from working was thrown away instead.

It no longer guesses. When an answer does not start, OnFlip reads the session straight out of the page: if you really are signed out it says so and stops, because sending again cannot help; if the session is fine it retries, because that is the case that almost always works. The same went for a page that navigated while loading a chat — Playwright calls that "interrupted", which OnFlip was reading as *you* interrupting it.

**Session logs no longer swallow whole documents.** Every failed tool call records its arguments, uncapped — so asking the agent to write a document with a shell command put the entire document in the log. One entry held 3.6 KB of it; one session file reached 620 KB. Arguments are now capped at 500 characters each, and the log says how many characters it left out rather than trimming silently. Typed keystrokes are still redacted completely, at any length.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.14...desktop-v0.10.15](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.14...desktop-v0.10.15)
