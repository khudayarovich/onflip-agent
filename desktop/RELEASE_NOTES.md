# OnFlip Desktop 0.10.58

**Rate limits, handled: a Free ChatGPT account, DeepSeek and Qwen stop running into theirs — and a pause is no longer the end of the work.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.58.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.58/OnFlip-Setup-0.10.58.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.58-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.58/OnFlip-0.10.58-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.58-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.58/OnFlip-0.10.58-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

- **A limit is a pause, not the end of the task.** When a service says "too many requests", OnFlip waits as long as it asks — at least 30 seconds — and then carries on by itself. Stop cancels that. A message you type during the pause is sent when it ends. Only short pauses are waited out like this: after a limit measured in hours, or an abuse block, OnFlip tells you and leaves the next step to you.
- **The agent's browser opens pages from your project folder.** A small game or page written as plain HTML can be looked at straight away, as `index.html`, without starting a local server first. Only files inside the working folder.
- **"Always allow" for your own pages.** The agent's browser can be allowed once for pages on this computer — `localhost`, `127.0.0.1` and pages in the working folder — so testing your own app no longer asks at every click. Websites on the internet still ask every time. This matters most on a Mac, which has no Full Auto mode.

## Fixed

**ChatGPT on a Free account**

- **Far fewer new chats and summaries.** OnFlip assumed a Free account's model could hold 8,000 tokens, which left room for almost nothing after its own instructions. It now reads the real figure from your account — about 35,000 for GPT-5.6 Luna. On a test task, building a chess game went from 231 seconds, 15 steps and 3 chats to 48 seconds, 4 steps and 1 chat.
- **Replies are no longer cut off or mistaken.** A short "I'll build this…" at the start of a reply is no longer taken for the whole answer, and a reply that stops halfway is asked for again instead of writing half a file.
- **"Done" can no longer claim a change that failed.** If an edit did not land, the AI is sent back once to make it, and you are told if it still did not.
- The first message no longer collides with the account checks at start-up, which could leave a session running without knowing its plan.
- No "OnFlip" project is created in your ChatGPT account for chats that never appear in it anyway.

**DeepSeek**

- **No more lost messages.** DeepSeek silently ignores roughly the eleventh message in a minute, and OnFlip waited 90 seconds each time before sending it again. It now keeps under that pace. On a test task: no messages lost, where earlier runs lost 2 and 6.
- Answers are recognised as finished sooner, and a message that does get lost is noticed in 25 seconds instead of 90.
- DeepSeek's own tool-call format is understood instead of appearing as garbled text.

**Qwen**

- **When Qwen holds your messages, you are told at once.** Qwen's risk control sometimes answers "overcrowded, please try again later" instead of replying. OnFlip showed an empty answer, waited four minutes and sent again into the block — twelve minutes with nothing done. It now says so within seconds, pauses for ten minutes (in our tests the block lifted by itself within 10–15), and suggests switching to DeepSeek or ChatGPT meanwhile.
- Qwen's daily limit ("wait 4 hours") is read: OnFlip stops and tells you, instead of pausing five minutes and running into it again.

**All services**

- DeepSeek and Qwen now respect their own pauses. Before, they sent the very next message straight into the limit.
- **On a Mac, DeepSeek and Qwen could close their own browser at start-up:** two parts of OnFlip opened it at once, and the second closed the first.
- Notices name the service you are using — a DeepSeek session was told "ChatGPT stopped…".

Everything from 0.10.57 is included: passwords stay out of what the AI is told about a page, and typed text is hidden in tool cards.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.57...desktop-v0.10.58](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.57...desktop-v0.10.58)
