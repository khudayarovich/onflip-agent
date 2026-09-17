# OnFlip Desktop 0.10.50

**Undo, schedules, sessions and usage counting are now safe when files change or several OnFlip windows work at once.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.50.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.50/OnFlip-Setup-0.10.50.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.50-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.50/OnFlip-0.10.50-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.50-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.50/OnFlip-0.10.50-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

- **Undo no longer overwrites your newer work.** Before restoring a file, OnFlip now verifies both its content and filesystem identity. If you or another program changed the file after the agent's edit, Undo refuses safely and keeps the snapshot available.
- **Two windows can no longer write the same session at once.** Session locks are now provider-scoped and acquired atomically. Failed saves remain pending instead of being mistaken for completed saves.
- **Scheduled prompts fire once.** Overlapping timer ticks are coalesced, all due entries are claimed before the first asynchronous send, and a damaged `schedules.json` is preserved instead of silently replaced.
- **Usage totals no longer lose concurrent updates.** The shared JSON counter has moved to transactional SQLite, with a one-time migration of existing totals and a native binding for every packaged platform.

## Improved

- Desktop JSON state is written atomically, so a crash cannot leave a half-written settings, indicator or Telegram file.
- Filesystem revision checks, Undo restoration and session locking now live in focused modules with regression coverage.
- Electron is updated to 42.11.4, the bundled SQLite native modules match its ABI on Windows and both macOS architectures, and `diff` is updated to 9.0.0.
- Both dependency trees now report zero known vulnerabilities.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek, Qwen or Arena account — one, or all four. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.49...desktop-v0.10.50](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.49...desktop-v0.10.50)
