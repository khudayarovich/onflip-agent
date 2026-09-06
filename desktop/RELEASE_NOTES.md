# OnFlip Desktop 0.10.0

**DeepSeek, as a second service.** Same app, same agent, same tools — switched from the account menu. DeepSeek is free with no plan tiers and no message caps to work around, so an agent's dozens-of-messages-per-task appetite stops mattering at all. ChatGPT is untouched: same sign-in, same chats, same settings, same behaviour.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.0.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.0/OnFlip-Setup-0.10.0.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.0-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.0/OnFlip-0.10.0-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.0-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.0/OnFlip-0.10.0-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Two services, one app

**Switch to DeepSeek** in the account menu restarts OnFlip on the other service. Each keeps its own sign-in, chats, projects and settings, and nothing crosses between them — switching back needs no new login.

| | ChatGPT | DeepSeek |
| --- | --- | --- |
| Cost | Free plan upward | Free |
| Models | Whatever your plan offers | Instant · Expert · Vision |
| Reasoning | Off · low · medium · high | DeepThink on or off |
| Attachments | Yes | Yes |
| Projects | Yes | No |
| Usage caps | Per plan | None to work around |

Signing in works the same way on both: OnFlip opens your real browser on a profile of its own. Google refuses OAuth inside an embedded or automated browser — measured four different ways while trying to make one work — so a real browser is not a workaround here, it is the only thing that signs in.

## What's new

- **DeepSeek as a provider.** Its three modes appear in the model chip, and DeepThink is a switch beside them rather than a four-level dial it does not have.
- **The service is named in the titlebar** — *OnFlip × DeepSeek* — and in the account row, which now shows your actual DeepSeek account name.
- **Attachments are visible in the transcript.** Each file sent with a message sits above it as a chip, iconed by what it is, and clicking one opens Explorer or Finder with the file selected.
- **Replies fill in as they arrive** on DeepSeek instead of appearing all at once after a minute of "working".
- **The About page** documents both services and which limits belong to which.
- **`/` commands follow the service** — the two ChatGPT-only ones are not offered where they cannot work.

## Fixed

- **Stop now stops.** On DeepSeek the button ended the turn in the app while the page kept writing. Two faults: the signal was ignored, and once that was fixed the click itself silently threw every time — it landed on the button's SVG icon, which has no `click()` method, and the error was swallowed. A turn now stops in the same second.
- **Attachments reached DeepSeek but confirmation took a minute.** It waited for the file's name to appear on the page, which is the one thing an image never shows. Now 2.9 seconds, confirmed, instead of 64 unconfirmed.
- **The two services could read each other's settings.** DeepSeek's model picker offered GPT-5.6, and the app reported a connected account on a service nobody had signed in to — because one config file held one model, one plan and one session. Each service now has a room of its own, and a ChatGPT session is filed as ChatGPT's whichever service is running.
- **Signing out of one service could have taken the other's session with it.** Found while fixing the above; it never shipped in a form anyone could hit, but the code was there.
- **DeepSeek hung on long chats.** Its transcript unmounts off-screen messages, so counting them is not a progress signal; completion is decided by the reply text going quiet.
- **Turns are about 3.5 seconds faster** — the settle window was longer than it needed to be.
- **Sidebar spacing.** The project row and the session card beneath it were touching.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key.

**Full changelog:** [desktop-v0.9.1...desktop-v0.10.0](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.9.1...desktop-v0.10.0)
