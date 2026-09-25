# OnFlip Desktop 0.10.62

**The agent can use its browser with the Browser panel closed, and OnFlip tells ChatGPT when it reaches for tools that cannot see your computer.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.62.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.62/OnFlip-Setup-0.10.62.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.62-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.62/OnFlip-0.10.62-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.62-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.62/OnFlip-0.10.62-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**The agent's browser**

- **Clicks and screenshots work with the Browser panel closed.** If the panel had never been opened, the agent's page had no size at all: every click waited fifteen seconds and failed, and every screenshot failed with "Cannot take screenshot with 0 width". So the agent could not check what it had built — a game's animation, say — and could not tell whether its change had worked. The page now keeps a real size while the panel is closed, and animations run there as they would on screen.

**ChatGPT**

- **ChatGPT's own tools are named, and the AI is told when it used one.** ChatGPT's models often run tools of their own in the middle of a reply: a hidden code runner on OpenAI's servers, searches for files in the chat, even attempts to hand the task to Codex. None of these can see your computer, they cost time, and on a Free plan they can count against its limits. OnFlip's instructions now name them, OnFlip tells the AI after each reply which ones it used and what to use instead, and the log records every call. In testing, the attempts to hand work to Codex all but stopped; ChatGPT's hidden code runner still runs at times, and that part is ChatGPT's own — OnFlip cannot switch it off.

Everything from 0.10.61 is included: Free accounts run on the GPT-5.6 Luna that has no limit.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.61...desktop-v0.10.62](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.61...desktop-v0.10.62)
