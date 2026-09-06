<div align="center">

<img src="desktop/buildResources/logo.svg" alt="OnFlip" width="88" height="88">

# OnFlip

**An agent for coding and everyday tasks, powered by your own ChatGPT or DeepSeek account.**

No API key. No per-token billing. On ChatGPT's free plan or on DeepSeek, no bill at all.

[![Download](https://img.shields.io/github/v/release/khudayarovich/onflip-agent?label=download&sort=semver)](https://github.com/khudayarovich/onflip-agent/releases/latest)
[![CI](https://github.com/khudayarovich/onflip-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/khudayarovich/onflip-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/khudayarovich/onflip-agent/releases/latest)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ea4aaa)](#support-the-project)

<img src=".github/assets/screenshot.png" alt="The OnFlip desktop app" width="900">

</div>

## Why an agent on a chat subscription

One task is never one message. "Fix this failing test" is a dozen or more: read
the file, run the build, read the error, edit, run it again. That multiplication
is what makes API-priced agents expensive — every step is billed.

OnFlip is not priced per step, because it does not use the API. It drives the
chat session you are already signed in to — ChatGPT or DeepSeek — so an agent
that works all afternoon costs exactly what your account already costs:

> **On the Free and Go plans, that is nothing.** In August 2026 OpenAI made
> **GPT-5.6 Luna** the default for Free and Go users and
> [removed the daily cap on text chats entirely](https://techcrunch.com/2026/08/06/openai-brings-unlimited-chatgpt-text-chats-to-free-users/) —
> unlimited messages, on a model that makes
> [62% fewer factual errors than Instant](https://openai.com/index/improving-gpt-5-6-sol-in-chatgpt/).
> An agent's dozens-of-messages-per-task appetite stops being a cost at all.
>
> **On Plus and Pro**, the same app runs on **GPT-5.6 Sol** and its far larger
> context window — OnFlip reads your plan and the model's window and sizes its
> own context budget to match, so long sessions summarise themselves far less
> often.

The honest caveat: unlimited covers *text*. Free accounts still have limits on
file uploads, which OnFlip uses to hand over unusually large turns, so very
long sessions go further on a paid plan.

> **Or skip plans entirely.** OnFlip also drives **DeepSeek**, which has no
> tiers to work around: Instant, Expert and Vision modes, DeepThink on or off,
> and image attachments, at no cost. Switch services from the account menu.

## What it is

OnFlip is a desktop app that turns a chat account into a working agent. It
reads and edits files on your computer, runs commands, browses the web, and
produces documents — asking your approval before anything risky.

Everything happens on your machine. There is no OnFlip server, no telemetry, and
no account to create: the app talks to the chat service through your own browser
session and to nothing else.

## Two services, one app

OnFlip drives one service at a time. **Switch to DeepSeek** / **Switch to
ChatGPT** in the account menu restarts the app on the other one; each keeps its
own sign-in, chats, projects and settings, and nothing crosses between them.

| | ChatGPT | DeepSeek |
| --- | --- | --- |
| Cost | Free plan upward | Free |
| Models | Whatever your plan offers | Instant · Expert · Vision |
| Reasoning | Off · low · medium · high | DeepThink on or off |
| Attachments | Yes (upload limits by plan) | Yes |
| Projects | Yes — chats filed into an "OnFlip" project | No |
| Reopen earlier chats | Yes | Only ones OnFlip started |
| Usage caps | Per plan, see below | None to work around |

## Install

Download the latest build from the [releases page](https://github.com/khudayarovich/onflip-agent/releases/latest).

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11 | `OnFlip-Setup-<version>.exe` | Updates in place; settings and sessions are kept. SmartScreen warns because the build is unsigned — *More info → Run anyway*. |
| macOS (Apple Silicon) | `OnFlip-<version>-mac-arm64.dmg` | Drag to Applications. First launch needs **right-click → Open → Open**. |
| macOS (Intel) | `OnFlip-<version>-mac-x64.dmg` | Same as above. |

On first launch OnFlip asks you to sign in to the service it is set to — ChatGPT
by default. **Open Chrome to sign in** starts your real Chrome (or Edge, or the bundled browser when neither is installed) on a private profile that belongs to OnFlip — no automation, no flags, exactly the browser you use every day, so Google, Apple, Microsoft and email sign-ins all work. Sign in there, close the window when the chat page appears, and OnFlip drives that same profile from then on. Nothing is decrypted or copied out of your own browser, and your everyday browser profile is never touched.

Already signed in to ChatGPT in Firefox, or in Safari on a Mac? **Use my Firefox or Safari session** imports it directly (Safari needs OnFlip to be granted Full Disk Access). Chrome and Edge encrypt their cookies with a key bound to the browser, so those sessions cannot be read by anything else — that is the browser's protection, and OnFlip does not go around it; the sign-in above is the way in for them. A machine with neither Chrome nor Edge gets OnFlip's own bundled browser, downloaded once (about 150 MB) the first time it is needed.

The session lives in `~/.onflip/browser-profile` (DeepSeek's in
`~/.onflip/providers/deepseek/browser-profile`), together with the browser it was
made with, and survives restarts. **Sign out** in the account menu clears the
one for the service you are on, and leaves the other alone.

DeepSeek signs in exactly the same way. Google refuses OAuth inside an embedded
or automated browser, so both services open your real one — which is why signing
in with Google, Apple or Microsoft works at all.

## What it can do

- **Work in a project folder.** Open a directory and describe a change. OnFlip reads the code, edits it, runs your build or tests, and reports what actually happened — never what it imagines happened.
- **Work with no folder at all.** Start a chat without a project and ask for a document, a spreadsheet, a script. Files it produces appear in the transcript with **Save** and **Open** buttons.
- **Run commands.** A real shell, behind an approval layer you control — from read-only through to unrestricted.
- **Browse.** A real browser you can watch *and touch*: click, scroll and type into the page the agent is driving, then hand it back.
- **Two sessions at once.** Each window runs its own agent with its own browser, the way two chat tabs are two conversations.
- **Two services.** ChatGPT or DeepSeek, switched from the account menu, each with its own sign-in and its own chats.
- **Undo and inspect.** Every file change is snapshotted: see the diff for the session, revert the last change, export the transcript.

## Support the project

OnFlip is free, MIT-licensed, and built in the open by one person. It has no
paid tier and collects nothing from you — if it saves you time, a contribution
keeps it maintained.

<table>
<tr>
<td width="60%" valign="top">

**Ways to help**

- ⭐ **Star the repository** — free, and the single biggest help
- 🐛 **Report bugs** with a log excerpt, or suggest a feature
- 💛 **Sponsor** if OnFlip earns a place in your workflow

</td>
<td width="40%" valign="top">

**Donate**

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/khudayarovich)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/khudayarovich)

</td>
</tr>
</table>

## Approval modes

Every side effect passes through one policy, chosen per session:

| Mode | Behaviour |
| --- | --- |
| **Read-Only** | Reads and searches. Nothing is changed. |
| **Ask First** | Every write and every command needs your approval. |
| **Auto-Edit** | Edits inside the workspace run freely; commands still ask. |
| **Full-Access** | Runs everything except destructive commands. |
| **Unrestricted** | Runs everything, including destructive commands. |

Approvals can be granted once or remembered as a rule (`git *` allowed, `rm *` denied), and rules are per command pattern rather than per session.

## How it works

```
┌──────────────┐     ndjson RPC     ┌───────────────┐    Playwright    ┌────────────┐
│  Electron UI │ ◄────────────────► │ engine (Node) │ ◄──────────────► │  ChatGPT   │
└──────────────┘                    └───────────────┘                  │     or     │
                                            │                          │  DeepSeek  │
                                            │                          └────────────┘
                                       tools│ files · shell · browser · web
                                            ▼
                                     your computer
```

The renderer draws; it never touches your files. The **engine** is a separate Node process that owns the agent loop, the tools and the approval policy. It talks to the chat service by driving a real browser session — the same pages you would use yourself — and turns replies into tool calls it executes locally. Which service that is sits behind one seam, so the agent loop, the tools and the approval policy are the same code either way.

One window pairs with one engine, which is what makes two concurrent sessions genuinely independent.

There is no OnFlip server. Nothing is sent anywhere except to the chat service you are signed in to, by your own browser session.

## Your data

- **Your session** — ChatGPT's or DeepSeek's — is stored on your machine (`~/.onflip`) and used only to talk to that service. The two are kept apart on disk, and neither can read the other's.
- **Conversations** are plain JSON on disk, readable and deletable by hand.
- **Files** are read and written where you point the agent; nothing is uploaded anywhere else.
- **Chats OnFlip creates** on chatgpt.com are filed into an "OnFlip" project so they stay out of your main list, and deleting a session offers to delete them too. DeepSeek has no projects, so its chats stay in its own list.

## Frequently asked

**Does this break the service's terms?** OnFlip drives a real browser session as a logged-in user, with no automation flags and no bypassing of any check — Cloudflare challenges are completed by you, in a real window. You are responsible for using your account within OpenAI's or DeepSeek's terms.

**Why can't it just read my Chrome session?** Chrome and Edge encrypt their cookies with a key bound to the browser itself, and recent Chrome refuses to be driven with its own profile. Both are deliberate anti-theft protections, and the ways around them are the ways malware gets in — so OnFlip does not go around them. Instead it signs in inside the real browser on a profile of its own, and drives that profile afterwards with the same browser, which can read its own cookies. Firefox sessions can still be imported directly.

**Which model does it use?** On ChatGPT, whatever your account offers, chosen from the model chip: Free and Go accounts default to GPT-5.6 Luna, the plan with unlimited text chats; Plus and Pro run GPT-5.6 Sol in regular chat. On DeepSeek the chip offers its three modes — Instant, Expert and Vision. Reasoning effort is a separate control (four levels on ChatGPT, a DeepThink switch on DeepSeek), and OnFlip sizes its context budget from whichever you are on.

**Can I use both accounts?** Yes, one at a time. Switching restarts the app on the other service; both sign-ins stay valid, so switching back needs no new login.

**Does it cost anything per message?** No. There is no API key and nothing metered — the work costs whatever your ChatGPT account costs, which on the Free and Go plans is nothing. Limits still apply to things that are not plain text (image generation, file uploads), and when ChatGPT throttles an account OnFlip waits it out rather than hammering it.

**Do I need a paid plan?** No. A free ChatGPT account runs the agent, and unlimited text chats suit an agent workload of many small messages. A paid plan buys a much larger context window, so long sessions compact themselves less often — and DeepSeek is free outright, with no tiers at all.

## Building from source

Requires Node.js 20+.

```bash
git clone https://github.com/khudayarovich/onflip-agent.git
cd onflip-agent
npm install                 # builds the engine
cd desktop && npm install
npm start                   # builds and launches the app
```

To produce installers, see [RELEASING.md](RELEASING.md).

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues have [their own process](SECURITY.md).

## License

[MIT](LICENSE) © Farrukh Khudayarovich Yuldashev

OnFlip is an independent project. It is not affiliated with, endorsed by, or sponsored by OpenAI or DeepSeek.
