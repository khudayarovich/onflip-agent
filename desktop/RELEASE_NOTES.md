# OnFlip Desktop 0.10.65

**OnFlip now checks the agent's work itself before it accepts "done", and files that contain code blocks are no longer written half-finished.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.65.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.65/OnFlip-Setup-0.10.65.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.65-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.65/OnFlip-0.10.65-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.65-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.65/OnFlip-0.10.65-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**OnFlip checks the work before it says "done"**

- OnFlip remembers the build, test and typecheck commands that passed in each project. When the agent says it is done after changing code, and nothing has checked the change since, OnFlip now runs the quickest of those checks itself. If it passes, the turn ends as usual. If it fails, the errors go back to the agent to fix, and the fix is checked again — you get "done" only when the check passes, or a clear note that it still fails.
- It only uses checks that passed in that project before and take under two minutes, skips changes to text files such as `.md`, and does not repeat a check the agent already ran. The check runs like any other command, so it appears as a card in the chat and follows your approval mode. To turn it off, set `checkBeforeDone` to `false` in OnFlip's config.

## Fixed

- **Files that contain a code block are written whole.** A Markdown file the agent wrote could stop in the middle — right at the end of its first code block — with everything after it missing, because ChatGPT's page ended the agent's file at that point. OnFlip now takes the complete file from ChatGPT's own reply stream when the page cut it short, holds back a file that ends inside an unfinished code block instead of saving half of it, and asks the agent to send such files in a form the page cannot cut.
- **Stopping a background server works when the agent names it differently.** Asked to stop a server with `job_id` instead of `id`, the stop command answered that no such job existed, so the agent left the old server running beside a new one. Both spellings work now.

Everything from 0.10.64 is included: questions you can answer with a click, the agent checking its web pages for console errors, and "Please enable the file tools" no longer stopping the work.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.64...desktop-v0.10.65](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.64...desktop-v0.10.65)
