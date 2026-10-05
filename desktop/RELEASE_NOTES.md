# OnFlip Desktop 0.10.72

**A calmer workspace for your next idea: graphite and mint, a warm light theme, and smoother interactions throughout.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/desktop-v0.10.72/.github/assets/screenshot.png" width="820" alt="OnFlip's redesigned workspace with example project data">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.72.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.72/OnFlip-Setup-0.10.72.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.72-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.72/OnFlip-0.10.72-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.72-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.72/OnFlip-0.10.72-mac-x64.dmg) |

The `.zip` and `.blockmap` files are for the in-app updater. A `SHA256SUMS` file ships alongside, and the updater checks it for you. Existing installs offer the update in the app.

## What's new

- **A new workspace look.** Graphite surfaces, mint accents, locally bundled Inter typography, a lowercase wordmark, consistent outline icons, and a warm light theme. The existing OnFlip symbol remains in use.
- **A more useful home.** Your account greeting and real recent projects, with suggestions that fill an editable draft. Project cards pick up your latest conversation.
- **Work within reach.** Preview, Changes, and Terminal share dock navigation. Review actual file diffs in the dock or open the full searchable review. Switching panels retains the browser page, running command, and terminal output.
- **Search anything.** Ctrl/Cmd+K opens the action palette; Ctrl/Cmd+F searches your conversation. Settings include shortcuts to their sections.
- **Clearer connections.** ChatGPT, DeepSeek, Qwen, and Gemini API cards show the active service's real account, model, and connection state. Switching services still restarts OnFlip and keeps each service's chats separate.
- **Smooth, adjustable motion.** Short transitions and focus feedback throughout, with an appearance toggle and automatic respect for your system's reduced-motion preference. English, Russian, and Uzbek copy is included.

## Fixed

Approval prompts stay above Settings and keep keyboard focus. Enter carried over from typing cannot activate an approval button when the prompt first appears. Escape answers the approval without closing the Settings dialog underneath it.

## Validation

Engine and desktop typechecks and production builds passed. The regression suite passed 1,613 tests, with four skipped. Production-renderer checks covered themes, navigation, all four provider layouts, rejected service switches, draft recovery, stopping a turn, diff and terminal docks, preview bounds and modal parking, keyboard focus, reduced motion, and compact layouts.

Renderer checks use an isolated bridge fixture and example projects. They do not run live model turns or verify native browser rendering. This release changes the interface; provider quotas and rate-limit behavior are unchanged.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini. Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.71...desktop-v0.10.72](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.71...desktop-v0.10.72)
