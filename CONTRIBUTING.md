# Contributing to OnFlip

Thanks for taking an interest. Bug reports are as welcome as pull requests — a
good report about a failure you can reproduce is often worth more than a patch.

## Reporting a bug

Open an [issue](https://github.com/khudayarovich/onflip-agent/issues) and say
what you did, what happened, and what you expected instead.

The single most useful thing you can attach is the session log. OnFlip writes
one JSONL file per session to `~/.onflip/logs/` (`C:\Users\<you>\.onflip\logs\`
on Windows), and it records the shape of every message sent and received. If
the app itself died rather than the turn, `engine-stderr.log` in the app's data
directory is the one that says why.

**Read before you attach.** Logs contain the prompts you sent and paths on your
machine. At `debug` level they contain full payloads. Redact anything you would
not post publicly.

Do not report a security issue in a public issue — see [SECURITY.md](SECURITY.md).

## Getting set up

Node.js 20 or newer.

```bash
npm install                 # installs and builds the engine
cd desktop && npm install   # installs the app
npm start                   # builds and launches
```

If Electron's binary is missing after install (some npm versions skip install
scripts), run `node node_modules/electron/install.js` inside `desktop/`.

Useful while developing:

- `ONFLIP_DESKTOP_DEBUG=1` prints the renderer's console to stdout.
- `ONFLIP_BROWSER_HEADLESS=0` shows the browser the agent drives.
- `~/.onflip/logs/` is where the engine explains itself.

## The shape of the codebase

| Path | What lives there |
| --- | --- |
| `src/agent` | The agent loop, the tool protocol, compaction, approvals |
| `src/chatgpt` | Talking to ChatGPT: transport, browser automation, backoff |
| `src/tools` | What the agent can do: files, shell, web, browser, todos |
| `src/auth` | Finding and reusing a ChatGPT session |
| `desktop/electron` | The Electron shell: windows, IPC, sign-in, terminal |
| `desktop/engine` | The agent process the app talks to over ndjson RPC |
| `desktop/ui` | The React renderer |

The engine runs as a separate Node process on purpose; see
[docs/architecture.md](docs/architecture.md).

## Before you open a pull request

```bash
npm run typecheck                      # engine
cd desktop && npm run typecheck        # main, engine host and renderer
cd desktop && npm run build            # renderer builds
```

CI runs the same three on Linux, Windows and macOS.

## House style

This codebase has a particular way of writing comments, and matching it is the
main thing a reviewer will ask for. Comments explain **why**, and the best ones
carry the evidence that made the code the way it is:

```ts
// Three token probes, not the full five with their late reload. One probe was
// tried and it broke filing: whenever the token lagged even briefly, the
// snapshot came back empty, the URL then withheld the id too, and the chat
// landed unfiled with its id untracked.
```

That comment is worth keeping because it stops the next person from "simplifying"
the code back into a bug. A comment that restates the code is not.

Beyond that: match the surrounding naming and formatting, prefer editing an
existing file to adding a new one, and keep a change to one concern. There is no
linter to argue with — read the neighbours instead.

Commit messages are written as sentences that say what changed and why, not as
conventional-commit prefixes.

## What tends not to be merged

- Anything that bypasses a security check, spoofs a browser, or works around
  another program's protection of its own data. OnFlip drives a real session as
  a real user; that line is deliberate and is not moved.
- Automation flags on the browsers OnFlip drives — they are what gets a session
  challenged or blocked.
- Telemetry, analytics, or anything that sends user data anywhere but ChatGPT.
