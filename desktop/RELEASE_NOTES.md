# OnFlip Desktop 0.10.67

**When ChatGPT stops accepting messages, OnFlip now works out whether to wait or to send less, instead of retrying in a loop. And the agent can click buttons in games that keep redrawing their menus.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.67.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.67/OnFlip-Setup-0.10.67.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.67-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.67/OnFlip-0.10.67-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.67-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.67/OnFlip-0.10.67-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**When ChatGPT will not take a message**

- When ChatGPT keeps its send button off, OnFlip now checks whether it would take any message at all. It types a single character without sending it and sees whether the button comes on.
- If a new chat takes nothing, OnFlip pauses for 10 minutes and says why. The usual cause is a usage limit. Before, OnFlip reloaded the page and retyped the whole conversation every minute and a half until the session gave up.
- If only this message is refused, OnFlip sends a shorter version of the conversation. This usually means the message is too long for the model.
- OnFlip's log now records what ChatGPT's page says at that moment, in whatever language the page uses, so the reason can be found afterwards. Copy diagnostics shows which of the two cases it was.

**"Compact after" is capped at what works**

- A "Compact after" value you set in Settings is now limited to what the model can hold and what one typed message can carry. A higher value let a conversation grow too long for ChatGPT to take back when a chat was lost.
- On a Free plan, 280,000 now works as about 57,000, and the context meter says it was capped. Lower values are used as you set them.

**The agent's browser**

- The agent can click a button however it writes the button's reference: `1`, `ref1` or `[ref_1]` as well as `ref_1`. Before, it was told the button was not on the page, went in circles, and gave up checking its own game.
- Buttons in menus that a game keeps redrawing can be clicked. The agent finds the same button again by its name and clicks it where it is now.

**Task lists**

- The agent's task list is accepted in the other form the agent sometimes sends it in, instead of being refused and sent again.

Everything from 0.10.66 is included: pages are checked by their whole console, and a Free account is moved off a model with a message limit.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.66...desktop-v0.10.67](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.66...desktop-v0.10.67)
