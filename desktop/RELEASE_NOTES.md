# OnFlip Desktop 0.10.55

**The agent starts out knowing your project, and spends fewer round trips finding its way around it.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.55.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.55/OnFlip-Setup-0.10.55.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.55-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.55/OnFlip-0.10.55-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.55-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.55/OnFlip-0.10.55-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

- **Every session starts with a map of your project.** The agent used to open a task by listing folders and searching for files, one round trip at a time. It now starts out knowing the layout, with your source folders first.
- **"Where is this defined?" in one step.** A new *Find Definition* step finds a function, class or type by name — JavaScript and TypeScript, Python, Go, Rust, Java, Kotlin, C#, Swift, C and C++, PHP, Ruby, PowerShell and more — instead of a search through every place it is used.
- **It remembers how your project is checked.** When a build, test, lint or typecheck command passes, OnFlip notes it for that project, and the next session is told which command works, in which folder, and how long it takes — so it checks its work with a command that works instead of guessing. The note lives in OnFlip's own settings folder, never in your project.
- **Forms in one step.** Filling a form in the agent's browser is now one action and one approval for the whole form, instead of one per field. Password fields are still masked in the approval, and typed values stay out of OnFlip's logs.
- **Quieter when you are away (DeepSeek and Qwen).** After 20 minutes without use, OnFlip stops checking your session in the background; after two hours it closes the service's hidden browser. Coming back to the window wakes it at once. The first message after a long break carries the conversation into a fresh chat on the service, as it does after Stop.

## Changed

- **Changes to instruction files always ask first.** `AGENTS.md`, `CLAUDE.md`, OnFlip's project memory and skills steer every future session, so a change to one now asks for your approval in Auto-Edit and Full-Access too — including the agent's own *Remember*. Otherwise a web page or a document the agent had read could talk it into writing instructions that every later session would then follow. Other edits in Auto-Edit go through as before, and YOLO still runs everything.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.54...desktop-v0.10.55](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.54...desktop-v0.10.55)
