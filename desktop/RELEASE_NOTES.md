# OnFlip Desktop 0.10.78

**ChatGPT's redesigned page works again, and a signed-out profile is told so at once instead of waiting.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/desktop-v0.10.78/.github/assets/screenshot.png" width="820" alt="OnFlip workspace">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.78.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.78/OnFlip-Setup-0.10.78.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.78-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.78/OnFlip-0.10.78-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.78-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.78/OnFlip-0.10.78-mac-x64.dmg) |

Existing installs offer the update in the app. The zip and blockmap files support the updater, which checks the accompanying SHA256 digest.

## Fixed

- **"Still working" forever on ChatGPT (issue #1).** ChatGPT replaced its web page in October 2026. OnFlip could still type and send on the new page, but it could not see the reply, the sent message or the stop control, so every message waited out the stall guard and retried. OnFlip now reads the new page: its message box, its send and stop controls, its message bubbles and replies, and its code blocks, which no longer use `<pre>` and had been flattening tool calls into one line.
- **No session, no waiting.** A profile that has never signed in, or whose session has gone, was sent into ChatGPT's anonymous page and reported the problem 135 seconds later. OnFlip now checks the profile's own session before typing anything and says "sign in" within seconds, keeping the message for after the sign-in. The anonymous page's current wording is recognised too.
- The start-up checks no longer hunt for a token on a profile the sign-in probe has already found empty, which held the first message for half a minute.

## Changed

- The new ChatGPT page ignores the model named in the chat's address and opens every chat on the model chosen in ChatGPT's own picker. OnFlip now says so once per chat and points at that picker. On a Free account the page has no picker, and the unlimited model is what runs.

## Validation

Engine and desktop typechecks passed. The full regression suite passed 1,637 tests with four skipped, including new checks for the October 2026 page shapes, the new code-block markup and the anonymous-page rules. Verified live with the shipped engine on a Free account and a Pro Lite account: "Hello" now ends in 11 and 30 seconds with the closing block intact, where before the fix it ran out two 240-second stall guards; a profile with no session is refused in under 11 seconds instead of 135.

## Installing

Windows builds are unsigned: if SmartScreen prompts, choose **More info → Run anyway**. On macOS, first launch with **right-click → Open → Open**.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account, or a Google AI Studio API key for Gemini.

**Full changelog:** [desktop-v0.10.77...desktop-v0.10.78](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.77...desktop-v0.10.78)
