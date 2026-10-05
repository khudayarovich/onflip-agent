# OnFlip Desktop 0.10.74

**Tooltips explaining Free-plan restrictions now stay opaque and readable over the composer.**

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.74.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.74/OnFlip-Setup-0.10.74.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.74-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.74/OnFlip-0.10.74-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.74-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.74/OnFlip-0.10.74-mac-x64.dmg) |

Existing installs offer the update in the app. The `.zip` and `.blockmap` files support the updater, which checks the accompanying SHA256 digest.

## Fixed

Unavailable attachment and reasoning controls previously reduced the opacity of their entire contents, including the explanation tooltip. Text underneath showed through, and the tooltip could fall behind the textarea. Only the control's icon and label are dimmed now; the explanation stays fully opaque above the composer.

Mouse hover and keyboard focus both show the readable card in dark and light themes. The mint app icons and workspace design from 0.10.73 remain included.

## Validation

The production renderer build and existing renderer workflow checks passed. Targeted browser checks reproduced the tooltip at 45% effective opacity before the fix, then verified 100% opacity on hover and focus in both themes, with visual inspection of all four states. These checks use an isolated bridge fixture; no model account is used.

## Installing

Windows builds are unsigned: if SmartScreen prompts, choose **More info → Run anyway**. On macOS, first launch with **right-click → Open → Open**.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini. Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.73...desktop-v0.10.74](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.73...desktop-v0.10.74)
