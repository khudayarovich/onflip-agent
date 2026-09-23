# OnFlip Desktop 0.10.53

**Tasks finish a round trip sooner, and Qwen sends faster.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.53.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.53/OnFlip-Setup-0.10.53.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.53-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.53/OnFlip-0.10.53-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.53-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.53/OnFlip-0.10.53-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

- **One round trip less at the end of a task.** The agent can now send its final summary together with its last check — a build or a test run. If every edit applies and the check passes, the task ends right there instead of waiting for the model to say it again; if the check fails, the agent is told what failed and keeps working. That extra round trip ended almost half of all requests in real sessions, at 3 to 13 seconds each.
- **Qwen sends sooner.** A new Qwen chat now waits for Qwen's own sign-in confirmation rather than a fixed pause, and each message goes as soon as Qwen's Send button takes the text rather than after a fixed delay — about half a second off a new chat and a fifth of a second off every message. On a slow page it waits exactly as long as before, so a message is never sent before Qwen knows who is sending it.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.52...desktop-v0.10.53](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.52...desktop-v0.10.53)
