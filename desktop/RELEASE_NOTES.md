# OnFlip Desktop 0.10.10

**Longer conversations, a `bash` tool that is actually bash, and the agent's own fetches kept on the public internet.** Seven fixes, all of them from a close audit of a live install — including one that had been quietly costing paid accounts ten times their conversation length.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.10.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.10/OnFlip-Setup-0.10.10.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.10-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.10/OnFlip-0.10.10-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.10-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.10/OnFlip-0.10.10-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**Your conversations may get ten times longer.** OnFlip sizes how much conversation it keeps from your account's plan — and it only ever asked for that plan when it had nothing stored, so a value that went stale was never corrected. An account recorded as Free while actually on a paid plan kept **4,000 characters** of conversation instead of 40,000, which means summarising itself almost every turn, and every summary starts a fresh chat and re-sends everything. The plan is now checked at each start and corrected, with a note telling you it happened. If this was you, long chats will feel markedly different.

**The `bash` tool now runs bash.** It used your login shell only when that shell was itself bash, and fell back to `/bin/sh` otherwise — so on any Mac (where the login shell is zsh) the tool named `bash` had never been bash. No `[[ ]]`, no arrays, different word splitting, and failures that looked like the agent writing bad commands when the commands were fine.

**The command allowlist stops collecting things that are not commands.** Approved commands were split into parts by a rule that knew nothing about quotes, so `sqlite3 db "select … ; … vnc"` was cut inside the quoted text and each fragment stored as a command you had approved. Real installs had `"`, `"select` and `vnc"` in the list — and on Windows, PowerShell variable names like `$os` and `$path`. Splitting now understands quotes, an entry has to look like a command to be stored at all, and `sudo` is never remembered. Existing lists are cleaned automatically on the next save.

**The agent's own fetches stay on the public internet.** `web_fetch` and `download_file` would reach anything — services on your own machine, the network around it, and the cloud metadata address that hands out credentials — with no prompt under full-auto. Private and loopback addresses are refused now, judged by what a name actually resolves to, and every redirect hop is checked rather than only the first address. If you deliberately point the agent at a local server, `ONFLIP_ALLOW_PRIVATE_FETCH=1` allows it again, and the refusal says so.

**Binary files are recognised as binary.** The check counted every high byte as ordinary text, so it was really measuring control characters — and handed most binaries to the model as text. It now decodes.

**An instruction file too large to load says so.** `AGENTS.md` and its siblings are skipped above 32KB, because they are re-sent every turn and come out of your conversation budget — but the skip was silent. OnFlip's own repository was the example: an 89KB `AGENTS.md`, dropped from every prompt, with nothing anywhere saying so. It now tells you, with the file and its size, so you can split it.

**A broken tool call is no longer shown as the answer.** A reply that was nothing but malformed JSON was treated as ordinary prose and handed to you as the work.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.9...desktop-v0.10.10](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.9...desktop-v0.10.10)
