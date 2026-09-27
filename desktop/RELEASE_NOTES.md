# OnFlip Desktop 0.10.66

**The agent now reads a page's warnings and logs, not only its errors, so it can check work it cannot see — like a 3D scene.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.66.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.66/OnFlip-Setup-0.10.66.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.66-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.66/OnFlip-0.10.66-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.66-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.66/OnFlip-0.10.66-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Improved

**The agent checks pages by their whole console**

- When the agent opens a page from your computer in its browser — a file in your project or a local server — it now sees the page's console warnings and logs as well as its errors. A game whose models failed to load often says so only as a warning, and until now the agent could not see it, so it reported "verified" while nothing had changed on screen.
- The agent cannot see a canvas or a 3D scene, so it is now told to log what it changed — which models loaded, their sizes and positions — and read those lines to check its work. No screenshots are sent to ChatGPT, so nothing is taken from a Free plan's image allowance.
- Errors come first, then warnings, then logs, each with its own limit, and a line repeated every frame is shown once with a count. A development server's own chatter is left out, and pages on the internet are still ignored.

## Fixed

- **A Free account no longer stops on a model with a message limit.** On the Free plan, a session pinned to a model with a message limit (`gpt-5-6`) is now moved to the GPT-5.6 Luna that has none, and OnFlip says why. On a Mac on Free, the limit ran out mid-task and ChatGPT stopped accepting messages on that model. OnFlip then kept reloading the chat and typing it in again until the session stopped. The pin was often not a choice at all, because an older version of OnFlip set it by itself. Paid plans keep whatever model you picked.

Everything from 0.10.65 is included: OnFlip checks the agent's work before it accepts "done", and files that contain code blocks are written whole.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.65...desktop-v0.10.66](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.65...desktop-v0.10.66)
