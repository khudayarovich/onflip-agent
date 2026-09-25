# OnFlip Desktop 0.10.60

**ChatGPT replies in long chats are read again, a usage limit is a pause rather than a loop, and the plan follows the account you sign in with.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.60.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.60/OnFlip-Setup-0.10.60.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.60-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.60/OnFlip-0.10.60-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.60-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.60/OnFlip-0.10.60-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**ChatGPT**

- **Replies in long chats are read again.** In a long chat ChatGPT now keeps only the last few messages on the page, and OnFlip sometimes could not see a reply ChatGPT had already finished. It waited a minute and a half, said "The sent message never appeared", and typed the whole conversation again into a new chat — ten times in one afternoon on one account, which is what used up its allowance. OnFlip now takes the reply from ChatGPT's own data when the page does not show it, and checks the page's copy against that data, so an older message is never taken for the new reply.
- **A usage limit is a pause, not a loop.** When ChatGPT says something like "unavailable until usage resets at 3:42 PM", it also stops accepting messages. OnFlip did not recognise that, so it kept reloading the page and sending the conversation again. It now reads the time the limit lifts and says so. A short wait carries on by itself; a long one leaves the next step to you.
- **The plan follows the account you sign in with.** After signing in with a different ChatGPT account — a Free account in place of a Pro Lite one, say — OnFlip kept using the previous account's plan and model list. It now reads both again after every sign-in and checks the plan after each reply. On a Free account that means the Free rules apply: replies kept to a size the plan allows, conversations sized for its limits, and no metered Thinking models. Nothing to do after updating: OnFlip checks when it starts.

**Diagnostics**

- **The log says which model answered, and what ChatGPT did behind the scenes** — running code on its side, for example, which counts against a Free account's "files, images, and data analysis" allowance. If an allowance runs out again, the log shows what used it.

Everything from 0.10.59 is included: a ChatGPT sign-in holds, and DeepSeek's thinking is not mistaken for an error.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.59...desktop-v0.10.60](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.59...desktop-v0.10.60)
