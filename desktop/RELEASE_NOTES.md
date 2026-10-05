# OnFlip Desktop 0.10.71

**More reliable provider turns, shared cooldowns, and safer local changes.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.71.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.71/OnFlip-Setup-0.10.71.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.71-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.71/OnFlip-0.10.71-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.71-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.71/OnFlip-0.10.71-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **Shared provider pacing and cooldowns.** Engine windows coordinate sends and conversation creation. DeepSeek's rolling send window survives restarts, and Gemini's short quota waits pause other windows. Server reset delays are preserved, including waits longer than an hour. These changes reduce unnecessary requests; service quotas and safeguards still apply.
- **DeepSeek and Qwen turn reliability.** Fresh chats apply and verify the requested settings after navigation. Qwen waits for its model picker to load and restores the selected model during recovery. Shortened composer input is rejected, configured reply timeouts are honored, and unfinished replies never reach the tool parser. DeepSeek recognizes HTTP refusals before attempting another send.
- **Gemini streaming and model settings.** Broken or unfinished streams fail visibly, blocked finishes are rejected, and Stop cancels stalled streams. Thinking controls match known model families and name the minimum supported effort accurately. Model discovery follows catalogue pagination, and service outages leave a saved key unverified instead of declaring it invalid.
- **Safer persistence and downloads.** Configuration writes are serialized across processes, including Windows lock contention. Downloads recheck their destination after approval and fetching, and replace files atomically. Failed logging stays isolated from the running session.
- **Schedules and incomplete tool replies.** Catch-up scheduling respects its grace window, invalid schedule updates are rejected together, and exhausted truncation retries cannot execute a partial write or accept completion.

## Validation

Local Windows checks: 1,613 passing tests, four skipped; engine and desktop typechecks and production builds passed. Ten six-process stress trials preserved all 3,600 counted configuration updates. Live account/key checks passed for DeepSeek, Qwen and Gemini, and Qwen model selection was verified. Full live generation turns were not exercised.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini. Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.70...desktop-v0.10.71](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.70...desktop-v0.10.71)
