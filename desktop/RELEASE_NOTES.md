# OnFlip Desktop 0.10.77

**A slightly smaller text scale and explicit OnFlip taskbar branding on Windows.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/desktop-v0.10.77/.github/assets/screenshot.png" width="820" alt="OnFlip workspace">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.77.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.77/OnFlip-Setup-0.10.77.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.77-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.77/OnFlip-0.10.77-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.77-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.77/OnFlip-0.10.77-mac-x64.dmg) |

Existing installs offer the update in the app. The zip and blockmap files support the updater, which checks the accompanying SHA256 digest.

## Improved

- Conversation text and the composer use 15px instead of 16px.
- Controls and code use 13px instead of 14px, and dialog headings use 17px instead of 18px.
- Secondary labels remain 12px to keep them readable. The shared scale applies throughout both themes.
- Windows taskbar entries explicitly use the OnFlip name, app ID and mint icon, including the relaunch command. Development launches retain the checkout path when reopened from the taskbar.

The duplicate-greeting and stream-capture fixes from 0.10.76 remain included.

## Validation

Desktop typechecks, the production renderer build and renderer workflow checks passed. The full regression suite passed 1,625 tests with four skipped. Taskbar identity checks cover packaged and development relaunches. Targeted renderer checks covered home, conversation and Settings at 760, 900, 1280 and 2048px, both themes, composer bounds and matching text/highlight metrics. These checks use example data and isolated storage.

## Installing

Windows builds are unsigned: if SmartScreen prompts, choose **More info → Run anyway**. On macOS, first launch with **right-click → Open → Open**.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini.

**Full changelog:** [desktop-v0.10.76...desktop-v0.10.77](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.76...desktop-v0.10.77)
