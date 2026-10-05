# OnFlip Desktop 0.10.75

**Comfortable text sizes throughout OnFlip, from your conversation to the sidebar and Settings.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/desktop-v0.10.75/.github/assets/screenshot.png" width="820" alt="OnFlip's workspace with larger text and example project data">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.75.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.75/OnFlip-Setup-0.10.75.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.75-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.75/OnFlip-0.10.75-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.75-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.75/OnFlip-0.10.75-mac-x64.dmg) |

Existing installs offer the update in the app. The `.zip` and `.blockmap` files support the updater, which checks the accompanying SHA256 digest.

## Improved

- **Readable text.** Conversation text and the composer use 16px, controls use 14px, and secondary labels use 12px. Dialog headings use 18px; code and terminal output use 14px. This replaces the 9–11px text used across much of the redesigned interface.
- **Consistent sizing throughout.** Sidebar chats, navigation, model and permission controls, status labels, menus, provider cards, Settings, tool output, and other dialogs share the same typography scale in both themes.
- **Compact layouts retain readable text.** Composer controls collapse their labels sooner, and long model names stay on one line. Hidden labels retain accessible names, and control explanations appear on keyboard focus as well as hover.

The mint branding and opaque plan-explanation tooltips from the previous releases remain included.

## Validation

Desktop typechecks, the production renderer build, and existing renderer workflow checks passed. The regression suite passed 1,613 tests with four skipped.

Targeted renderer checks covered 760, 900, 1280, and 2048px window widths, dark and light themes, conversation and Settings layouts, readable text sizes, composer control bounds, and text/highlight alignment. Keyboard tooltips and compact control names were verified. Free-plan explanation tooltips remained fully opaque on hover and focus in both themes.

These checks use an isolated bridge fixture and example projects, without model accounts.

## Installing

Windows builds are unsigned: if SmartScreen prompts, choose **More info → Run anyway**. On macOS, first launch with **right-click → Open → Open**.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini. Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.74...desktop-v0.10.75](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.74...desktop-v0.10.75)
