# OnFlip Desktop 0.10.76

**Greetings finish in one request, and complete answers avoid an unnecessary retry when the browser stream capture misses their ending.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/desktop-v0.10.76/.github/assets/screenshot.png" width="820" alt="OnFlip's workspace with readable text and example project data">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.76.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.76/OnFlip-Setup-0.10.76.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.76-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.76/OnFlip-0.10.76-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.76-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.76/OnFlip-0.10.76-mac-x64.dmg) |

Existing installs offer the update in the app. The `.zip` and `.blockmap` files support the updater, which checks the accompanying SHA256 digest.

## Fixed

- **One request for a greeting.** The recorded "hello" conversation received a complete greeting, then OnFlip asked the model to repeat it inside a closing block. Whole greetings and acknowledgements can now finish immediately when no work is open and no tool ran. Greetings that include a task, unfinished plans, model refusals and malformed calls retain the normal completion checks.
- **Complete answers survive an incomplete stream capture.** A recent answer was fully displayed on ChatGPT's page while the stream watcher captured only its beginning. An idle page's closed `done` or `ask_user` block can now resolve that mismatch when it extends the captured text and contains no machine tool calls. Explicit length limits, unfinished fences, live or failed streams, and replies containing file changes or commands remain protected by the truncation check.

This removes avoidable OnFlip requests. Provider quotas and safeguards still apply; it does not guarantee unlimited use. The latest inspected chat contained no rate-limit error and did include one use of ChatGPT's own web search.

The redesigned workspace, mint branding, opaque tooltips and readable typography remain included.

## Validation

Engine and desktop typechecks and the desktop engine build passed. The full regression suite passed 1,623 tests with four skipped. New regressions replay the recorded greeting through the real agent loop, verify one send and one final event, and exercise stream/page reconciliation alongside explicit truncation and incomplete-write protections. These checks use isolated configuration and scripted replies without spending model-account requests.

## Installing

Windows builds are unsigned: if SmartScreen prompts, choose **More info → Run anyway**. On macOS, first launch with **right-click → Open → Open**.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini. Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.75...desktop-v0.10.76](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.75...desktop-v0.10.76)
