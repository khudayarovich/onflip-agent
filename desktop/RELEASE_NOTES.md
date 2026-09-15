# OnFlip Desktop 0.10.39

**Turns that froze and would not continue, a permission button you could not read, and a place to watch what the agent hands off to itself.** The largest batch in a while, held back deliberately so it could go out as one thing.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.39.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.39/OnFlip-Setup-0.10.39.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.39-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.39/OnFlip-0.10.39-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.39-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.39/OnFlip-0.10.39-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

*(0.10.38 was tagged and its build failed before publishing anything, so this release carries its changes too.)*

## Fixed

**A stopped turn that would not continue — every attempt stuck on "sending", then "thinking", for ever.**

Three faults, compounding. Qwen marks a button disabled with a style rather than a real disabled flag, so a click on it lands and does nothing — OnFlip already knew that about the Send button and defended against it, but not about **Stop**. So interrupting a turn could leave the page still writing. The next message then went out behind that unfinished answer, and the wait — which decides "is anything happening" from Stop being on screen — read a button that was never going away as work in progress. Nothing timed out, because the safety net was exactly the thing being fooled. Every retry inherited the same page and did the same thing.

Stop is now pressed and then *checked*. Every turn makes sure the page is quiet before sending, reloading it if it will not settle. And a page claiming to work while writing nothing is believed for a good while — a model thinking before it answers is normal — but no longer for ever.

**Signing out was only noticed when you sent something.** The session was checked once at startup and then not again, so a session that ended while the app sat open was discovered by writing a message, sending it, waiting, and being told afterwards. It is re-checked quietly in the background now, so the banner tells you before you type.

**A message lost to a dead session.** If a turn fails because the session has gone, what you typed comes back into the composer — including across a switch to another service, which restarts the app. It is never re-sent on its own; it is just there, waiting for you.

**The "always allow" button was unreadable.** It spelled out the whole command it was offering to remember, which since 0.10.32 is the *exact* command — so approving a file written with a here-document put the entire file inside the button. It says **Always allow** now, with what it would remember shown separately, and only when that is not already obvious. On Telegram the same button used to say "Always allow" twice and then run out of room.

**Edit, resend and copy were three different sizes.** Two were text characters and the third an icon, which no amount of styling reconciles. All three are icons now, at one size.

## New

**Sub-tasks.** OnFlip can hand a self-contained job — the sort that reads a great deal and concludes very little — to a second agent with its own conversation, so your chat gains a paragraph instead of thirty file listings. Until now that work was invisible: a note that it had started, a pause, an answer. There is a **Sub-tasks** panel in the sidebar menu now showing what each one is doing, what it did, how long it took and what it came back with. Live while it runs.

**A switch for it**, in Settings, if you would rather watch every step in one conversation.

**A way off a dead service.** When you are signed out, the banner now offers the other services directly, alongside Sign in.

**Diagnostics that carry the log.** Copying diagnostics now includes the recent activity that explains a fault, instead of just naming the file it is in. What it leaves out is deliberate: the filter names the fields it may include, so a report you paste somewhere cannot carry your own words along with it.

**The Browser pane can be turned off** in Settings. It runs over a local debugging port that anything else on your machine can reach, and the port cannot exist without the feature — worth switching off on a computer other people have accounts on.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.37...desktop-v0.10.39](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.37...desktop-v0.10.39)
