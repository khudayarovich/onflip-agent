# OnFlip Desktop 0.9.0

**Run it from your phone.** Send OnFlip a task from Telegram, approve what it wants to do from the bus, and read the answer without going near your desk. That is the big one — but this release also adds scheduled prompts, a status light that floats above every other window, a real toolbar on the built-in browser, and a Changes view that finally shows all of the diff.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.9.0.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.9.0/OnFlip-Setup-0.9.0.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.9.0-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.9.0/OnFlip-0.9.0-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.9.0-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.9.0/OnFlip-0.9.0-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## OnFlip on Telegram

Put a bot token and your Telegram user ID into **Settings → Telegram** and the app answers to your phone. Anything you would type into the composer, you can send to the bot.

- **Approvals arrive as buttons.** The thing that actually made remote control work: a turn that stops for permission is no longer a turn that waits until you get home. Allow, allow-for-session or deny, from the phone.
- **Questions arrive as buttons too.** When the agent asks you to choose between options, the options are the buttons — no retyping an answer to a question you are looking at.
- **Screenshots come through** as pictures, not as a note saying a picture exists.
- **Commands** for a new chat, opening a project folder, the model, the thinking level and the access level, plus `/status` for what it is doing right now.
- **Replies are formatted**, not dumped — headings, code blocks and long answers split at sensible places rather than at the 4,096th character.

Only the IDs on your allow-list can talk to it, and the token is encrypted by the OS — DPAPI on Windows, the Keychain on macOS.

## Scheduled prompts

A saved prompt, a cron expression and the project it runs in. It fires on time and lands in the chat as though you had typed it. Useful for the things you would otherwise remember to ask on Monday morning.

## A status light for the corner of your screen

A small rounded square that floats above every window, with a voice-assistant-style wave inside it:

- **green** — idle, nothing running
- **red** — working
- **yellow** — stopped and waiting for *you*, an approval or a question

The yellow is the one that earns it. Without a state for "blocked", a turn waiting on permission looks exactly like a finished one, which is precisely the moment glancing at a corner of the screen is worth anything. Size it, move it, or turn it off in **Settings → Indicator**.

## Also new

- **A toolbar on the built-in browser** — back, forward, reload, and the address bar you expect at the top of a browser.
- **Copy buttons** on every message, and on every code block inside one.
- **The Changes view shows the whole diff.** It used to stop at 600 lines and say "diff truncated…" with no way to reach the rest — because there was no rest to reach; it had never left the engine. Now the full diff is sent, rendered a page at a time as you scroll, with a search box at the top that finds a match in the twentieth file without you scrolling to it.
- **The terminal looks like a terminal** — its colours are kept rather than flattened and mapped to the app's own palette, set in Ubuntu Mono where you have it and a considered fallback where you do not.
- **Skills rewritten** to tell the agent *how* to work rather than only what the task is.

## Fixed

- **Cloudflare challenged page after page** in the built-in browser — the same verification over and over, on a browser a person was sitting in front of and driving by hand. Electron advertises itself twice in every request, once as the app and once as the runtime, and those are the two most conspicuous tokens a bot check can see. Everything else already looked like a real browser; it was the name badge.
- **The window could be dragged narrower than what was open inside it**, leaving the terminal or the browser panel squeezed into nothing. It now stops at a width that fits what is showing.
- **The composer chips no longer overflow** when a side panel takes the chat's width — the model, thinking and access buttons drop their labels and keep their icons.
- **Sign-in says what to do, not just what failed.** Chrome 127 and later encrypt cookies so that only Chrome can read them, which is the point of that feature and not a fault any version of OnFlip can fix; the message said "cannot be decrypted" and left you looking for a fix that does not exist. It now points at the app's own sign-in window, which needs nothing set up. When Google refuses the window, the advice leads with **Try another way** — the step it rejects is usually a passkey, and that link walks straight past it.
- **The Chrome extension sign-in is gone.** It never worked for anyone, and it could not have: the three handlers behind it were wired from the main process through preload and into the renderer's types, and nothing in the app ever called them. It shipped in every build until now.
- **An empty session no longer shows an empty title** across the top of the window.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

## Under the hood

The Telegram bot polls; it opens no inbound port and needs no webhook, so nothing on your machine becomes reachable from the internet.

326 automated tests run on every push, up from 207.
