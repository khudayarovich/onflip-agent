# OnFlip

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An autonomous coding agent that runs in your terminal and is driven by your **ChatGPT web session** — no API key, no per-token billing. It reads and writes files, runs shell commands, searches the codebase, and verifies its own work, behind an approval layer you control.

```
▄▀▄ █▄ █ █▀ █   █ █▀▄
▀▄▀ █ ▀█ █▀ █▄▄ █ █▀
```

## Install

OnFlip is in a **private repository**, so installing it needs a GitHub account that has been given access. Ask the owner to add you as a collaborator first — you should be able to open <https://github.com/khudayarovich/onflip-agent> in a browser before you start.

### With GitHub CLI

The short path. Install [GitHub CLI](https://cli.github.com) (`winget install GitHub.cli`, `brew install gh`, or your package manager), sign in once, and the whole install is one line.

```bash
gh auth login
```

Windows, in PowerShell:

```powershell
gh api repos/khudayarovich/onflip-agent/contents/install.ps1 -H "Accept: application/vnd.github.raw" | iex
```

macOS or Linux:

```bash
gh api repos/khudayarovich/onflip-agent/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

### With a token

If you would rather not install GitHub CLI, create a token with read access to the repository at <https://github.com/settings/tokens> and hand it to the same installer.

Windows:

```powershell
$env:GITHUB_TOKEN = "ghp_yourtoken"
$h = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = "application/vnd.github.raw" }
Invoke-RestMethod "https://api.github.com/repos/khudayarovich/onflip-agent/contents/install.ps1" -Headers $h | iex
```

macOS or Linux:

```bash
export GITHUB_TOKEN=ghp_yourtoken
API=https://api.github.com/repos/khudayarovich/onflip-agent/contents/install.sh
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" "$API" | bash
```

### What the installer does

Checks your Node version, downloads the latest release, installs it globally with npm, fetches the browser OnFlip drives, and — on Windows — leaves an **OnFlip** shortcut on the Desktop that opens a session in one click. Nothing is compiled: the release ships already built.

<details>
<summary>Build from a checkout instead</summary>

Useful before the first release exists, or to run an unreleased branch. Add `-FromSource` (PowerShell) or `--from-source` (bash) to either command above, or do it by hand:

```bash
gh repo clone khudayarovich/onflip-agent
cd onflip-agent
npm install
npm run build
npm link
```

`npm install` builds and fetches Chromium on its own; set `ONFLIP_SKIP_BROWSER_DOWNLOAD=1` to skip the browser.

</details>

<details>
<summary>Install a release tarball by hand</summary>

```bash
gh release download --repo khudayarovich/onflip-agent --pattern "onflip-*.tgz"
npm install -g ./onflip-*.tgz
npx playwright install chromium
```

</details>

**Node.js 20 or newer**, and about 200 MB for the browser. Settings, sessions and logs live in `~/.onflip`. To remove it: `npm uninstall -g onflip`.

## Quick start

Three steps, once:

```bash
onflip login                # picks up the ChatGPT session from your browser
cd ~/code/my-project
onflip                      # opens the session
```

Then just say what you want:

```
› add a --json flag to the status command and make the tests pass
```

It reads the files it needs, makes the change, runs your build, and reports back — asking before each write and each command until you tell it not to. `esc` interrupts, `/exit` quits.

On Windows, the **OnFlip** shortcut the installer leaves on your Desktop does the third step for you: double-click it, then `/open` the folder you want to work in.

## Sign in

OnFlip reuses the ChatGPT session already in your browser — **Chrome, Edge, Brave, Chromium, Vivaldi, Arc or Firefox**, every profile of each, whichever it finds one in first. Log in at <https://chatgpt.com>, then:

```bash
onflip login
```

Chrome-family browsers on recent Windows use app-bound cookie encryption (v20), which cannot be decrypted — those are skipped and the search moves on to the next browser. **Firefox is the reliable one**: sign in to ChatGPT there and `onflip login` will find it.

Only the session cookies are carried across. Cloudflare's own cookies (`cf_clearance`, `__cf_bm`) and the edge ones are deliberately left behind — they are issued against one specific browser, so replaying another's is useless and looks like exactly the thing an anti-bot check is watching for. OnFlip's browser earns its own in seconds.

`onflip login --headed` exists for signing in through OnFlip's own browser, but expect Google's OAuth to refuse an automated browser — the cookie path above is the one to rely on.

## Running OnFlip

```bash
onflip
```

opens the interactive session. Or run a single task and exit:

```bash
onflip "add a --json flag to the status command and make the tests pass"
```

```bash
onflip -p "what does src/agent/run.ts do?"
```

`-p` prints just the final answer, which makes it pipeable.

Continue where you left off:

```bash
onflip --continue
```

## Which browser does what

Two different browsers are involved, and it is worth knowing which is which.

**Your browser** is only read, once, for its ChatGPT cookies — Chrome, Edge, Brave, Chromium, Vivaldi, Arc or Firefox, whichever has a session.

**OnFlip's browser** is your real installed **Chrome**, driven by Playwright, and it is the one that actually talks to ChatGPT. Playwright's bundled Chromium is the fallback when Chrome is not installed — but Cloudflare challenges that build, and its challenge cannot be completed by hand, which is why the real browser is preferred. Override with `ONFLIP_BROWSER_CHANNEL=chromium` (or `msedge`). The cookies from your browser are injected into it. So a session found in Firefox is still driven through Chromium — Playwright cannot drive your own Firefox profile, and OnFlip never touches your real browser windows.

It runs headless by default. If a browser window appears on every run, that is `headed` being on:

```bash
onflip config headed false
```

`onflip status` shows which mode you are in. Turning it *on* is useful when something is going wrong and you want to watch the page.

## Projects

A project is just a folder. Open one the way you would in an editor:

```bash
onflip ~/code/my-project
onflip .
```

Or switch without leaving the session:

```
/open ~/code/other-project    switch project
/open                         pick from recent projects
/cwd packages/api             move within this project
```

Tab completes directory paths after either command, and `~` expands.

**`/open` starts a new session; `/cwd` keeps the current one.** That split is deliberate — a directory is already how sessions are stored and resumed, and carrying a conversation about one codebase into another leaves every path in it wrong. `/cwd` is for stepping into a subfolder to run a build. When you open a project, OnFlip saves the session you were in, reloads that folder's `AGENTS.md` and git state, and tells you how many earlier sessions it has; `/sessions` resumes one.

Approval mode, model, and your shell rules follow you across the switch.

## Keeping OnFlip out of your ChatGPT sidebar

Every turn OnFlip runs starts a chat on chatgpt.com, and by default those pile up in your main list alongside your own conversations. Point them at a project instead:

```
/project              pick one, create one, or turn it off
/project OnFlip       choose it by name
/project new OnFlip   create it and use it
/project off          back to the main list
```

```bash
onflip projects       list them
```

Every chat OnFlip starts is moved into that project as soon as it exists, which is where ChatGPT's own sidebar files it — out of your main list, still there when you want it. The setting is remembered.

The chat is *started* on the ordinary page and filed afterwards, rather than being started inside the project: project pages require a full sign-in that a session read out of your browser does not satisfy. Filing needs nothing but the session already in use, so this works whichever way you signed in.

Chats already open are unaffected; this changes where the *next* one is filed. If filing ever fails, the chat still happens and lands in the main list, and OnFlip says so.

## Continuing a ChatGPT conversation

Your chats on chatgpt.com are threads OnFlip can pick up — including ones you started in the web UI, with no OnFlip involved.

```
/chats            the chats in your project
/chats tetris     filter by title
/chats all        the whole account instead
```

With a project set, `/chats` lists **only that project's** conversations — the ones OnFlip has been putting there. It asks the project directly rather than filtering the main list, so a project whose chats are older than the newest few dozen still shows all of them.

```bash
onflip chats      list them without starting anything
```

Choosing one attaches the session to that thread. The conversation keeps its own context on ChatGPT's side, so nothing is resent — ask "what did we decide?" and it answers from what is already there. Its visible messages are read back into the transcript so `/export` and the display have something real, and the tool protocol is sent once, on the first turn, since the thread has never seen it. From that point the agent can read files and run commands inside a conversation that started as an ordinary chat.

The link is remembered: resuming that session with `/sessions` or `-c` reopens the same thread rather than starting a new one.

Two things worth knowing. It needs the browser transport — the API path replays the whole transcript on every call, which would duplicate everything already in the thread. And a thread keeps the model it was started with; `/model` applies to new chats.

This is separate from `/sessions`, which lists OnFlip's own local transcripts.

## Approval modes

Every write and every shell command goes through a policy. Pick how much you want to be asked.

| mode | behaviour |
| --- | --- |
| `read-only` | reads and searches only — good for planning |
| `ask` | prompts before every write and command *(default)* |
| `auto-edit` | edits inside the workspace go through, commands still ask |
| `full-auto` | everything runs except commands flagged destructive |
| `yolo` | everything runs, including destructive commands |

```bash
onflip --approve auto-edit
onflip --full-auto
onflip --plan
```

Or `/approve` inside a session.

Commands that delete recursively, force-push, pipe a remote script into a shell, elevate privileges, or power down the machine are flagged and always prompt — except under `yolo`, which you have to confirm once when you turn it on.

When you approve something with "don't ask again", OnFlip remembers the command prefix (`npm test`, `git commit`) or the directory, and persists it to `~/.onflip/config.json`.

### Per-command rules

A single mode can't say "run anything, but never touch `rm`". Rules can, and they outrank the mode in both directions:

```
/permission "git *" allow
/permission "rm -rf /*" deny
/permission "git *" default       drop that one rule
/permission                       list them
/permission clear                 start over
```

`*` matches any run of characters, `?` matches one, and patterns are anchored, so `git *` cannot match `mygit`. **The last matching rule wins**, so write the catch-all first and refine it afterwards:

```
/permission "*" allow             hand over the shell
/permission "rm -rf /*" deny      except this
```

That pair is how you get full shell access without a permission mode standing in the way — and a `deny` rule still holds under `yolo`, which is the only reason to write one.

Rules live in `bashRules` in `~/.onflip/config.json`, and are editable there directly:

```json
{ "bashRules": { "*": "ask", "git *": "allow", "npm publish*": "deny" } }
```

## Queueing and interrupting

You never have to wait for the agent to finish before typing the next thing. The composer stays live for the whole turn.

- **`enter` while it's working** queues the prompt. It's echoed back as `queued #1`, and queued prompts run in order the moment the turn ends.
- **`esc`** interrupts the running turn. Anything already queued runs next, so "stop — do this instead" is one keystroke plus a sentence.
- **`esc` while idle** clears the queue.

The footer says which of the two `enter` will do, so it's never a guess.

## Tools

| tool | what it does |
| --- | --- |
| `read` | read a file with line numbers, `offset`/`limit` for big ones |
| `write` | create or overwrite a file |
| `edit` | exact-string replacement, unique-match enforced |
| `multi_edit` | several edits to one file, atomically |
| `list` | directory tree, build output skipped |
| `glob` | find files by pattern, newest first |
| `grep` | regex search across contents |
| `bash` | run a command; working directory persists between calls |
| `job_output` | read output from a backgrounded command |
| `todo_write` / `todo_read` | the task list you see rendered in the transcript |
| `web_fetch` | fetch a URL **from your machine**, so localhost and internal hosts work |
| `browser_open` / `browser_snapshot` | open a page in the agent's own browser · re-read it |
| `browser_click` / `browser_type` / `browser_key` | act on the page by element ref |
| `browser_screenshot` / `browser_close` | save a PNG for you · close the window |

### The agent's browser

The `browser_*` tools drive a real browser the agent can click around in — a page opens on your screen and you watch it work. It reads pages through the accessibility tree rather than pixels: every action returns the page's interactive elements, numbered, plus the visible text, and the agent acts on those numbers. Each navigation, click and keystroke goes through the same approval layer as every other tool.

This browser is **separate from everything else**: it is not your browser, and it is not the one that talks to ChatGPT. It keeps its own profile in `~/.onflip/browser-automation`, so a site you sign into there stays signed in for next time — sign in yourself when a task needs it; the agent is told never to enter credentials you did not hand it for that purpose. Screenshots land in `~/.onflip/screenshots`. Run it windowless with `onflip config browserHeadless true`.

`bash` uses PowerShell on Windows and `/bin/sh` (or bash) elsewhere. `cd` carries across calls the way it does in a real terminal, and `background: true` returns a job id for dev servers and watchers.

## Interactive commands

| command | |
| --- | --- |
| `/help` | commands and key bindings |
| `/new` · `/clear` | fresh session · clear the transcript |
| `/compact` | summarise the transcript to free up context |
| `/model` · `/models` | switch model · list them (`/models refresh` re-reads your account) |
| `/thinking` | set reasoning effort |
| `/approve` · `/shell` | approval mode · allow or block the shell entirely |
| `/permission` | per-command shell rules — `/permission "git *" allow` |
| `/diff` · `/undo` | what changed this session · revert the last change |
| `/todos` · `/tools` · `/status` | task list · available tools · configuration |
| `/sessions` | list and resume earlier sessions |
| `/chats` | continue one of your ChatGPT conversations |
| `/project` | keep new chats inside a ChatGPT project |
| `/init` | write an AGENTS.md describing this project |
| `/open` · `/cwd` | open a project folder · move within this one |
| `/export` | write the transcript to Markdown |
| `/exit` | quit |

Unique prefixes work, so `/appr` is `/approve`.

### Keys

`wheel` or `shift+↑ ↓` scroll the transcript · `pgup`/`pgdn` scroll a page · `ctrl+end` jump to the latest

`enter` send, or queue it if the agent is working · `esc` interrupt the turn, or clear the queue when idle

`ctrl+j` newline · `ctrl+c` interrupt the turn, or clear the composer · `ctrl+d` exit · `↑ ↓` history · `tab` accept or cycle a completion · `@` complete a file path · `tab` after `/open` completes a directory · `ctrl+w` delete a word · `ctrl+u` clear the line · `ctrl+l` clear the screen

## Full screen

OnFlip takes over the terminal the way a TUI does, using the alternate screen buffer: you get a clean canvas, and your shell scrollback is untouched and comes straight back when you exit.

The screen is three regions, and only the middle one moves:

```
  ▄▀▄ █▄ █ █▀ █   █ █▀▄   v0.2.0 · gpt-5.6-luna-wm · yolo   ← pinned
  ▀▄▀ █ ▀█ █▀ █▄▄ █ █▀    ~/code/my-project
  ────────────────────────────────────────────────
  … the transcript …                                 ← scrolls
  ────────────────────────────────────────────────
  ╭──────────────────────────────────────────────╮   ← pinned
  │ ›                                            │
  ╰──────────────────────────────────────────────╯
```

**Scroll with the mouse wheel**, or `shift+↑ ↓`, `pgup`/`pgdn`, and `ctrl+end` to jump back to the newest. Output arriving while you have scrolled up does not drag the page: your place is kept, and a line at the bottom counts what is waiting below.

Turning the wheel on means the terminal sends mouse events to OnFlip, so drag-selecting text needs `shift` held — the same trade every full-screen terminal program makes.

The alternate buffer has no scrollback of its own, so the transcript is kept in memory and scrolled with `shift+↑`/`shift+↓`, `pgup`/`pgdn`, and `ctrl+l` to jump back to the latest. A hint appears when output is arriving below your scroll position.

If you would rather it wrote into your scrollback like an ordinary command:

```bash
onflip --inline
onflip config fullscreen false
```

`-p` never takes the screen — its stdout is meant to be piped. Use `/export` to keep a transcript, since the screen is discarded on exit.

## Project context

On startup OnFlip loads instruction files from the working directory and its ancestors up to the repository root, closest file winning:

`AGENTS.md` · `AGENT.md` · `CLAUDE.md` · `ONFLIP.md` · `.onflip/instructions.md` · `.cursorrules` · `.github/copilot-instructions.md`

A file at `~/.onflip/AGENTS.md` applies to every project. `onflip init` writes a skeleton and has the agent fill it in from the actual codebase.

### Custom commands

Drop a Markdown file at `.onflip/commands/review.md` and `/review` sends its contents as a prompt. `$ARGUMENTS` is replaced with whatever you type after the command.

## Configuration

`~/.onflip/config.json`, editable with `onflip config <key> <value>`.

```bash
onflip config approvalMode auto-edit
onflip config theme nord
onflip config maxIterations 60
onflip config replyTimeout 900
onflip config compactAfterChars 60000
```

`replyTimeout` is how many seconds one reply may take, default 600. Reasoning effort and output size both push this up — a full-file rewrite at high effort can spend minutes thinking before the first token. Esc cancels a turn at any point, so a generous budget costs nothing but patience.

`compactAfterChars` is when the transcript gets summarised into a fresh ChatGPT thread — 60,000 characters by default, checked before *every* message rather than once per prompt. The number is not arbitrary: if a chat is lost mid-session the whole transcript is replayed into a new one, and the web composer will not accept a message much past that. A 112,000-character replay was measured failing outright. A single task can run dozens of steps and pull in more file and build output than twenty ordinary exchanges, and that long run is exactly the one that needs it. Lower it if replies start coming back truncated; `/compact` does it on demand, and `compactAfter` sets a message-count limit alongside it.

Themes: `opencode`, `onflip`, `nord`, `gruvbox`, `dracula`, `mono`.

### Models

The built-in list is only a starting point for a fresh install. Slugs change faster than any shipped list can track, and entitlements differ per plan — so read the real one from your own account:

```bash
onflip models --refresh
```

That calls the same `/backend-api/models` endpoint the web UI uses to populate its own model picker, and caches the result. Inside a session, `/models refresh` does the same, and the `/model` picker offers it as an entry.

Any slug the backend accepts works whether or not it is listed — `--model gpt-5.6-luna` is sent as typed, and dotted spellings resolve against the cached list. A slug that isn't cached is flagged rather than rejected, since it may simply be newer than your last refresh.

### Environment

| variable | |
| --- | --- |
| `ONFLIP_SESSION_TOKEN` | session token, skipping browser extraction |
| `ONFLIP_MODEL` · `ONFLIP_THINKING` | defaults for model and reasoning effort |
| `ONFLIP_APPROVAL` | default approval mode |
| `ONFLIP_TRANSPORT` | force `browser` or `api` |
| `ONFLIP_MAX_ITERATIONS` | step budget per turn |
| `ONFLIP_REPLY_TIMEOUT` | seconds allowed for one reply |
| `ONFLIP_BROWSER_CHANNEL` | `chrome` (default), `msedge`, or `chromium` |
| `ONFLIP_DEBUG` | print stack traces on error |

## Rate limits

OnFlip talks to ChatGPT through the browser, so it counts against your normal plan usage — but a few things are worth knowing.

**It never calls the backend API directly unless you ask it to.** Those requests carry no browser fingerprint, and ChatGPT answers them with "unusual activity has been detected from your device", which is an account-level flag rather than a per-request error. `ONFLIP_TRANSPORT=api` is available and deliberately opt-in.

**A throttle is never retried.** When ChatGPT returns 403 or 429, OnFlip stops, records a cooldown, and refuses to send until it lifts — including across restarts, since restarting and trying again is what turns a short block into a long one. `onflip status` shows the time remaining.

Sends are also paced so a fast tool loop cannot burst: there is a minimum gap between one message and the next.

## Logging

Every session writes a JSONL log to `~/.onflip/logs/`. It records what was sent, what came back verbatim, how each reply parsed, and every tool call with its timing and result — the things a terminal render cannot tell you after the fact.

```bash
onflip logs              # the last session, as a timeline
onflip logs -n 200       # more of it
onflip logs --full       # stop eliding the long payloads
onflip logs --raw        # JSONL, for grepping
```

A reply that fails to parse is recorded at warn level with the raw text, so a failure is diagnosable without reproducing it. `--debug` adds every payload and echoes the trace to stderr:

```bash
onflip --debug -p "check my disk space"
```

Logs stay on your machine and the newest 20 are kept. They contain your prompts, the model's replies and tool output, so treat them like a shell history.

## Troubleshooting

**`onflip: command not found` straight after installing.** The shell is holding an older PATH — open a new terminal. If it still cannot find it, `npm prefix -g` prints where npm put the shim; add that directory to PATH.

**`onflip login` finds no session.** Sign in at <https://chatgpt.com> first, and prefer **Firefox**. Chrome-family browsers on recent Windows encrypt cookies in a way that cannot be read (app-bound, "v20"), so those profiles are skipped with a note rather than used.

**"Could not find the ChatGPT message box", or a missing browser executable.** Playwright needs a browser binary: `npx playwright install chromium`. If Chrome is installed, OnFlip drives that instead — `onflip status` shows what it picked.

**Cloudflare is challenging the browser.** It usually clears itself within a few minutes. If it does not, `onflip logout` then `onflip login` picks up a fresh session.

**A turn ends with "the reply budget ran out".** Reasoning models can think for minutes before the first token: `onflip config replyTimeout 900`.

**Anything else.** `onflip logs --full` prints exactly what was sent and exactly what came back, which is usually the whole answer; `onflip status` shows the configuration it is actually running with.

## Updating and uninstalling

Re-run the installer to update — it always fetches the latest release:

```powershell
gh api repos/khudayarovich/onflip-agent/contents/install.ps1 -H "Accept: application/vnd.github.raw" | iex
```

```bash
gh api repos/khudayarovich/onflip-agent/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

To remove it:

```bash
npm uninstall -g onflip
```

That leaves `~/.onflip` — config, sessions and logs — alone. Delete the folder too if you want a clean slate.

## How it works

ChatGPT web has no function calling, so the tool protocol is plain text — and it is shaped around two things that break plain text.

**Escaping.** Asking a chat model to JSON-escape a shell command reliably fails. So calls are `key: value` lines with no escaping at all:

````
```onflip
tool: bash
command: |
  Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
    Select-Object DeviceID, @{Name='FreeGB';Expression={[math]::Round($_.FreeSpace / 1GB, 2)}}
```
````

Everything after `command: |` is taken literally — quotes, backslashes, `$_`, newlines.

**Rendering.** Replies are read back out of rendered HTML, and the Markdown renderer eats characters: an unfenced `$_.Size` loses its underscores to emphasis. The fence keeps the block verbatim, and the DOM is re-serialised rather than read with `innerText`.

Several blocks in one reply run together, which matters a lot when each round trip goes through a browser. A call that fails to parse is sent back for correction rather than shown to you as an answer.

Two transports exist. **Browser** drives a real ChatGPT tab through Playwright and is the default — it keeps working as long as you are logged in. **API** talks to the backend directly and is faster, but needs an access token Cloudflare often refuses to issue. `chooseTransport` prefers the browser when session cookies are available.

The system prompt spends most of its length on one problem: ChatGPT has its own sandbox and browsing tools, and left alone it will "run" your command there and report invented output. The prompt forbids those tools, and the loop additionally watches replies for claims of execution that arrive without a tool call, and asks the model to try again.

Sessions are JSON under `~/.onflip/sessions/`. Resuming replays the transcript into a fresh ChatGPT conversation, since the live thread does not survive the process.

## Limits

- Driving a web UI is inherently more fragile than an API. If ChatGPT changes its DOM, the browser transport may need new selectors.
- Rate limits are your ChatGPT account's.
- Reasoning effort on the browser path is a prompt instruction, not a real parameter — it nudges, it does not guarantee.
- `--print` cannot ask for approval, so it declines anything the policy would prompt for. Pair it with `--full-auto` for unattended runs.

## Desktop app (Windows)

[`desktop/`](desktop/) holds **OnFlip Desktop** — the same engine in a native window, styled after the Codex and Claude desktop apps. Sessions, approvals, rules and sign-in are shared with the CLI through `~/.onflip`, so the two can be used interchangeably.

```bash
npm install && npm run build    # once, at the repo root — the app imports dist/
cd desktop
npm install
npm start
```

[`desktop/README.md`](desktop/README.md) explains the three-process architecture and why the engine runs under plain Node rather than inside Electron.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev -- "your task"      # runs from src, no build step
```

[`AGENTS.md`](AGENTS.md) is the architecture guide — what each module owns, and the non-obvious reasons things are the way they are. [`RELEASING.md`](RELEASING.md) covers cutting a release.

## License

MIT
