# OnFlip Desktop 0.10.23

**OnFlip can hand a piece of work to a second agent and keep only the answer.** Some jobs read a great deal and conclude a little — and everything they read used to stay in your conversation forever.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.23.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.23/OnFlip-Setup-0.10.23.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.23-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.23/OnFlip-0.10.23-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.23-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.23/OnFlip-0.10.23-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**Sub-agents.** Ask OnFlip to find where something is handled across forty files, or work out why a test fails, and it can now give that job to a second agent with its own conversation. The forty files it reads stay in *that* conversation. Yours gets the answer.

This matters more than it sounds. What fills a long chat is not the talking — it is the output of tools, and a full chat is what forces OnFlip to summarise itself, which costs a request and a fresh start every time. Work that reads a lot and concludes a little is exactly the work worth doing somewhere else.

It is not free, and OnFlip knows it. Driving one chat at a time means the second agent takes the conversation, and yours is rebuilt on your next message — roughly what one summarisation costs. The agent is told that plainly, so it spends a sub-agent on a survey and not on reading a single file.

Some deliberate limits: a sub-agent cannot start sub-agents of its own, it cannot see your conversation (which is the whole point), it cannot stop to ask you a question, and it gets a smaller step budget than the main agent. If it runs out of steps, what comes back says so above its answer — a partial survey should never read as a finished one.

You will see it as a **Task** card in the transcript while it works, and its answer when it is done.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.22...desktop-v0.10.23](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.22...desktop-v0.10.23)
