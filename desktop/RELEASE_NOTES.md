# OnFlip Desktop 0.10.64

**OnFlip's questions now come with answers you can click, and the agent checks the web pages it builds for errors in the browser console.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.64.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.64/OnFlip-Setup-0.10.64.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.64-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.64/OnFlip-0.10.64-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.64-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.64/OnFlip-0.10.64-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

**Questions you can answer with a click**

- When OnFlip needs your decision, its answers are now buttons. The one the agent recommends comes first, marked **Recommended**, and each answer says what it means. Click one and the work carries on — or type an answer of your own in the box underneath. On Telegram the same answers are buttons, and tapping one sends the same reply.

**The agent checks the web pages it builds**

- When the agent opens a page from your computer in its browser — a file in your project, or a local server — it now sees the page's console errors: a script that crashes on load, a missing file, an import the browser blocks, each with the file and line. It is also told to open a web page it has built and fix those errors before it says it is done. Pages on the internet are left alone.

## Fixed

- **"Please enable the file tools" no longer stops the work.** ChatGPT sometimes answered by asking you to "enable the on-machine file tools for this session" and stopped, although OnFlip's tools are always on. OnFlip now recognises that request, tells ChatGPT its tools are there, and the work continues without you.
- **Answers like "Yes: build everything" show as text.** An answer option written with a colon appeared as code instead of as the answer.

Everything from 0.10.63 is included: full-auto no longer stops to ask before deleting a single temporary file, and the agent's browser understands key names however they are written.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.63...desktop-v0.10.64](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.63...desktop-v0.10.64)
