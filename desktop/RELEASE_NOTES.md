# OnFlip Desktop 0.10.73

**The OnFlip icon now matches the workspace: mint and deep green on graphite, across your desktop and the app.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/desktop-v0.10.73/.github/assets/screenshot.png" width="820" alt="OnFlip's mint icon and graphite workspace with example project data">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.73.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.73/OnFlip-Setup-0.10.73.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.73-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.73/OnFlip-0.10.73-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.73-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.73/OnFlip-0.10.73-mac-x64.dmg) |

Existing installs offer the update in the app. The `.zip` and `.blockmap` files support the updater, which checks the accompanying SHA256 digest.

## Fixed

- **Consistent app branding.** The existing flip symbol is recolored to mint and deep green on graphite. Windows application, installer, shortcut, window, and tray icons use the updated ICO; macOS uses the matching PNG. The sidebar, assistant identity, and About dialog show the same artwork in color.
- **Reliable icon regeneration.** Editing the master logo and running the icon command now updates the Windows ICO, macOS PNG, and renderer SVG together. Previously, the macOS PNG and renderer copy could stay stale.
- **Windows test compatibility.** The composer source check accepts Git's CRLF checkouts while preserving its draft-restoration assertions.

This follows 0.10.72's workspace redesign, with graphite and mint themes, command search, project navigation, provider connections, dock tabs, and adjustable motion. The flip symbol's shape is retained.

## Validation

Desktop typechecks and production-renderer workflows passed. All Windows icon sizes from 16 to 256 pixels and the 1024-pixel macOS PNG were checked for dimensions, transparency, and the updated palette. The regression suite passed 1,613 tests with four skipped.

Renderer checks use an isolated bridge fixture and example projects. This update changes branding; provider quotas and rate-limit behavior are unchanged.

## Installing

Windows builds are unsigned: if SmartScreen prompts, choose **More info → Run anyway**. On macOS, first launch with **right-click → Open → Open**.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini. Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.72...desktop-v0.10.73](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.72...desktop-v0.10.73)
