<div align="center">

<img src="desktop/buildResources/logo.svg" alt="OnFlip" width="88" height="88">

# OnFlip

**An agent for coding and everyday tasks, powered by the ChatGPT account you already pay for.**

No API key. No per-token billing. Your subscription, your machine, your files.

[![Download](https://img.shields.io/github/v/release/khudayarovich/onflip-agent?label=download&sort=semver)](https://github.com/khudayarovich/onflip-agent/releases/latest)
[![CI](https://github.com/khudayarovich/onflip-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/khudayarovich/onflip-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/khudayarovich/onflip-agent/releases/latest)

<img src=".github/assets/screenshot.png" alt="The OnFlip desktop app" width="900">

</div>

## What it is

OnFlip is a desktop app that turns your ordinary ChatGPT subscription into a working agent. It reads and edits files on your computer, runs commands, browses the web, and produces documents — asking your approval before anything risky.

Every other agent of this kind bills you per token through an API. OnFlip drives the ChatGPT web session you are already signed in to, so the work costs what your subscription already costs.

## Install

Download the latest build from the [releases page](https://github.com/khudayarovich/onflip-agent/releases/latest).

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11 | `OnFlip-Setup-<version>.exe` | Updates in place; settings and sessions are kept. SmartScreen warns because the build is unsigned — *More info → Run anyway*. |
| macOS (Apple Silicon) | `OnFlip-<version>-mac-arm64.dmg` | Drag to Applications. First launch needs **right-click → Open → Open**. |
| macOS (Intel) | `OnFlip-<version>-mac-x64.dmg` | Same as above. |

On first launch OnFlip asks you to sign in to ChatGPT. If you are already signed in to ChatGPT in a browser whose cookies it can read, it picks that session up and you never see a login form.

## What it can do

- **Work in a project folder.** Open a directory and describe a change. OnFlip reads the code, edits it, runs your build or tests, and reports what actually happened — never what it imagines happened.
- **Work with no folder at all.** Start a chat without a project and ask for a document, a spreadsheet, a script. Files it produces appear in the transcript with **Save** and **Open** buttons.
- **Run commands.** A real shell, behind an approval layer you control — from read-only through to unrestricted.
- **Browse.** A real browser you can watch *and touch*: click, scroll and type into the page the agent is driving, then hand it back.
- **Two sessions at once.** Each window runs its own agent with its own browser, the way two ChatGPT tabs are two conversations.
- **Undo and inspect.** Every file change is snapshotted: see the diff for the session, revert the last change, export the transcript.

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
┌──────────────┐     ndjson RPC     ┌───────────────┐    Playwright    ┌──────────┐
│  Electron UI │ ◄────────────────► │ engine (Node) │ ◄──────────────► │ ChatGPT  │
└──────────────┘                    └───────────────┘                  └──────────┘
                                            │
                                       tools│ files · shell · browser · web
                                            ▼
                                     your computer
```

The renderer draws; it never touches your files. The **engine** is a separate Node process that owns the agent loop, the tools and the approval policy. It talks to ChatGPT by driving a real browser session — the same pages you would use yourself — and turns replies into tool calls it executes locally.

One window pairs with one engine, which is what makes two concurrent sessions genuinely independent.

There is no OnFlip server. Nothing is sent anywhere except to ChatGPT, by your own browser session.

## Your data

- **Your ChatGPT session** is stored on your machine (`~/.onflip`) and used only to talk to ChatGPT.
- **Conversations** are plain JSON on disk, readable and deletable by hand.
- **Files** are read and written where you point the agent; nothing is uploaded anywhere else.
- **Chats OnFlip creates** on chatgpt.com are filed into an "OnFlip" project so they stay out of your main list, and deleting a session offers to delete them too.

## Frequently asked

**Does this break ChatGPT's terms?** OnFlip drives a real browser session as a logged-in user, with no automation flags and no bypassing of any check — Cloudflare challenges are completed by you, in a real window. You are responsible for using your account within OpenAI's terms.

**Why can't it use my Chrome session?** Chrome and Edge on Windows encrypt their cookies so that no other program can read them, and recent Chrome refuses to be driven with its own profile. Both are deliberate anti-theft protections and OnFlip does not work around them. Sign in through the app's window once — it remembers — or sign in to ChatGPT in Firefox, whose session OnFlip can read directly.

**Which model does it use?** Whatever your account offers; pick it from the model chip. Reasoning effort is a separate control.

**Does it cost anything per message?** No. It uses your existing subscription. Heavy use is still subject to whatever rate limits your plan has, and OnFlip backs off rather than hammering them.

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

[![Sponsor](https://img.shields.io/badge/GitHub-Sponsor-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/khudayarovich)

<!-- Add your own links here once you have them:
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/USERNAME)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/USERNAME)
-->

</td>
</tr>
</table>

## License

[MIT](LICENSE) © Farrukh Khudayarovich Yuldashev

OnFlip is an independent project. It is not affiliated with, endorsed by, or sponsored by OpenAI.
