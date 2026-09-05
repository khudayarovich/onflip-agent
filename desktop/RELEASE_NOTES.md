# OnFlip Desktop 0.8.5

**Chats no longer pile up, and sessions no longer drop out mid-task.** New conversations open as ChatGPT Temporary Chats, so an afternoon's work leaves nothing in your sidebar — and the bug that signed OnFlip out in the middle of long runs is fixed.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.8.5.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.5/OnFlip-Setup-0.8.5.exe) | 84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.8.5-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.5/OnFlip-0.8.5-mac-arm64.dmg) | ~104 MB |
| **macOS** · Intel | [OnFlip-0.8.5-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.5/OnFlip-0.8.5-mac-x64.dmg) | ~110 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

## What's new

- **Chats disappear when they're done.** Every new conversation is a ChatGPT Temporary Chat: it never enters your history, your sidebar, or the account's memory. Filing them into an "OnFlip" project used to move the clutter rather than remove it. Your model is unaffected — Luna stays Luna. Turn it off if you'd rather read the raw threads in ChatGPT afterwards.
- **Health checks.** OnFlip can now tell you what is wrong *before* a task runs into it: no session, a rate-limit cooldown, a full disk, or ChatGPT's page having changed under it. Each answer says what to do, not just what is true.
- **Roughly twice as much of a turn is now ChatGPT thinking rather than OnFlip waiting.** Measured on a live task, the app's own overhead fell from 27% of turn time to 12%, and sending a message went from ~630 ms to ~190 ms.

## Fixed

- **Signed out in the middle of a working session.** OnFlip read your browser's cookies at every start and wrote them over the session its own browser was already holding — a session ChatGPT had been keeping fresh all along. When the stored copy was older, the next chat opened signed out and every retry rewrote the same stale copy. In one measured run this cost seventeen minutes and thirteen failed turns. The browser profile now owns the session; a stored one is only used when there is nothing there, or when you explicitly sign in or import.
- **Edits that failed on invisible whitespace.** Asking to change a line whose indentation didn't match exactly — spaces where the file uses a tab — failed outright. It now matches with the whitespace relaxed, applies the file's own bytes, and keeps the file's indentation. Batched edits (`multi_edit`) never worked at all when written on one line; they do now.
- **The model was no longer being verified.** The check that catches a chat opening on the wrong model had silently stopped matching ChatGPT's page, so it could not have caught anything.
- **Requests that could never succeed.** Filing a chat into a project retried on every reply once it started failing, and the stray-chat sweep kept working through its list after the browser had closed — both adding traffic to an account that was already being rate-limited.
- **Bursts of new conversations.** Ten different recovery paths each start a fresh chat, and nothing paced them; one session opened 32 chats for 55 replies and was throttled for it.
- **Stopping a task no longer waits out a timer it doesn't need to.**
- Large turns are typed rather than uploaded as a file, which is about four times faster and avoids the model occasionally reporting the attachment as unreadable.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

## Under the hood

This release adds the project's first automated test suite — 126 tests covering the failure classification, the tool-call parser, the refusal detectors, the health checks and the page reader — and it runs on every push. Two long-standing bugs were found by it within an hour of it existing.

**Full changelog:** [desktop-v0.8.4...desktop-v0.8.5](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.8.4...desktop-v0.8.5)
