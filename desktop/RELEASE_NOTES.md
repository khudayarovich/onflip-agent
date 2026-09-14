# OnFlip Desktop 0.10.16

**A Health page, and the first thing it found fixed.** OnFlip has been writing a detailed log of its own runs since the first release, and nothing ever read it. Now there is a page that does — and the first number it produced was worth acting on immediately.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.16.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.16/OnFlip-Setup-0.10.16.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.16-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.16/OnFlip-0.10.16-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.16-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.16/OnFlip-0.10.16-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside if you want to check a download by hand.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**Health** — in the account menu. Three things:

- **Tool calls**, with how often each one fails. This is the number that started all of it: on one machine, 21% of every tool call had failed, `edit` had failed 52% of the time and `multi_edit` had failed on all nine of its calls. That had been true for weeks, written to disk, while the app showed you only the one error in front of you at the time.
- **What it cost to say** — messages sent, characters in each, and the total. This is what request limits are actually spent on.
- **What happened** — turns that failed, sends retried, cooldowns, compactions, and separately the compactions that did not shrink anything, which is the one that means your context budget is smaller than the conversation needs.

The page also runs the six diagnostic checks OnFlip has always had and never had a button for — the session, the plan, the browser profile, whether a cooldown is running, whether local storage is writable.

The point is not the numbers on any one day. It is being able to notice when one of them moves.

## Changed

**OnFlip says less to get the same work done.** Every message it sends carries a protocol reminder — the rules that stop a chat model from claiming it cannot reach your computer. It was 2,194 characters and it went out on every single send: 430,000 characters, 30% of everything the app had ever said.

It now arrives in full when it is worth its size — in a conversation that has not heard it yet, which includes every chat opened by a compaction; right after a step that went wrong; and every tenth step regardless. On a step that has just gone perfectly it sends 466 characters instead, carrying the two rules a drifting model actually forgets.

Whether that nets out is a real question, and it is one the Health page can now answer: a reply that drifts costs a whole round trip, and the saving is a fifth of one. The numbers are on the page either way.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.15...desktop-v0.10.16](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.15...desktop-v0.10.16)
