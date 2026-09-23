# OnFlip Desktop 0.10.52

**Follow-up requests go straight to the work, edits land exactly where they were asked, and nothing you type or attach is lost.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.52.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.52/OnFlip-Setup-0.10.52.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.52-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.52/OnFlip-0.10.52-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.52-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.52/OnFlip-0.10.52-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

- **Follow-ups are fast.** After a task finishes, the next request no longer reads the whole project again. Edit results show the lines as they now read, a second read of a file returns only what changed, each turn starts from the files the session already changed, and compaction keeps the lines being worked on instead of ordering a full re-read. A small change after a finished task takes seconds, not minutes.
- **Nothing you type or attach is lost.** A message the app could not send comes back to the composer with its files; Edit and Resend bring the files back too; and text brought back into the composer joins what you are typing instead of replacing it.
- **Uzbek written in Cyrillic is answered in Uzbek**, not Russian. The approval prompt and every confirmation now follow the app's language — English, Russian or Uzbek.

## Fixed

**Editing files**
- An edit changes what was asked, where it was asked, or refuses with the reason. Several cases reported success while damaging the file: a value cut short at a closing brace, an empty file after a write that lost its indentation, `package.json` refused as JSON, a replacement landing on the wrong line.
- Files in a legacy encoding (e.g. Windows-1251) are refused instead of having every non-ASCII character replaced.
- Files the agent writes end with a newline. Patches straight from `git diff`, and `-U0` insertions, apply at the right line.

**Tool calls**
- A reply cut off mid-block no longer saves half a file over the real one; the agent is asked to send the block again.
- A command the model only *shows* — in inline code, inside an example code block, or as a sentence after a block — no longer runs.

**ChatGPT, DeepSeek and Qwen**
- DeepSeek and Qwen no longer forget the conversation after their browser reopens, and a tool call written inside a numbered list now runs.
- ChatGPT never returns the previous reply as the new one and never sends twice into a refusal. Files attached to a message survive a send whose chat was dropped, and one very long line is pasted in full.
- A chat title or reply that merely mentions a rate limit, a "verify you are human" page or logging in no longer fails turns as a throttle, a challenge or a sign-out.
- Qwen confirms sends by the message appearing, reads the signed-in account from Qwen itself, and treats a rate limit as a rate limit rather than a sign-out. DeepSeek's sign-in no longer closes itself on a stale token, and a DeepSeek page that stops answering ends the turn instead of hanging it.

**Approvals and safety**
- Your command rules judge every command on a line: `git status && rm -rf ~` no longer passes on an allow rule for `git`.
- "Always allow" on a write never clears a whole drive or your home folder. Ctrl+A in the approval prompt no longer means "always".
- Downloads ask for network access; the network guard catches every IPv6 spelling of a local address.
- "Open" on a file from the chat launches documents, images, media and archives only, and shows anything else in its folder. The sign-in window hands only web links to your browser.
- Text a tool reads — a web page, a file — can no longer pose as OnFlip speaking.

**The app**
- On machines with Node 24 the usage counts work again: the engine runs where the shipped database opens.
- With two windows open, each window's agent drives its own browser panel. An engine being replaced no longer writes into the window, and a Telegram or scheduled message that arrives while you switch session or project waits until the switch is done.
- A session open in another window cannot be deleted from under it. Undo reverts the change its dialog named, and a second Undo of the same file works.
- Updates: a stalled download times out, a checksum that cannot be fetched stops the install instead of skipping the check, and the app reopens after installing. Only desktop releases are considered, and an update found while no window was open is offered again.
- A shell command that leaves a background process running no longer holds the turn; very large output is capped instead of crashing.
- All project instruction files share one budget, so a folder with several large ones no longer makes every send fail, and a copy (CLAUDE.md = AGENTS.md) is sent once.

**The window**
- Underscores in names and paths are no longer read as italics, numbered steps keep their numbers, and a message starting with a path such as `/api/login` is sent rather than rejected as an unknown command.
- Enter no longer fires while a Chinese, Japanese or Korean input method is still choosing characters. Escape closes the dialog on top instead of stopping the turn underneath it.
- The sidebar always lists the project you are in. The terminal panel keeps colours intact and no longer pulls you to the bottom while you read. One item that cannot be drawn no longer blanks the whole window, and long sessions redraw only what changed while an answer streams.

**Telegram and schedules**
- Long answers arrive in full; old buttons stop working once used; someone removed from the allow-list stops receiving messages.
- Schedules move strictly forward through the hour that repeats when summer time ends.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.51...desktop-v0.10.52](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.51...desktop-v0.10.52)
