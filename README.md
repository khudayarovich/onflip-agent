# OnFlip

An autonomous coding agent that runs in your terminal and is driven by your **ChatGPT web session** — no API key, no per-token billing. It reads and writes files, runs shell commands, searches the codebase, and verifies its own work, behind an approval layer you control.

```
▄▀▄ █▄ █ █▀ █   █ █▀▄
▀▄▀ █ ▀█ █▀ █▄▄ █ █▀
```

## Install

```bash
npm install && npm run build && npm link
```

Playwright needs a browser binary the first time:

```bash
npx playwright install chromium
```

## Sign in

OnFlip reuses the ChatGPT session already in your browser. Log in at <https://chatgpt.com>, then:

```bash
onflip login
```

If your browser encrypts cookies in a way OnFlip cannot read (Chrome's app-bound encryption, v20), sign in through OnFlip's own persistent browser profile instead:

```bash
onflip login --headed
```

## Use

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

From then on every new chat is created inside that project, which is where ChatGPT's own sidebar files it — out of your main list, still there when you want it. The setting is remembered, and applies from the very first chat of a session rather than the second.

Chats already open are unaffected; this changes where the *next* one is created. A project carries its own model, so `/model` applies to chats started outside one.

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
```

`replyTimeout` is how many seconds one reply may take, default 600. Reasoning effort and output size both push this up — a full-file rewrite at high effort can spend minutes thinking before the first token. Esc cancels a turn at any point, so a generous budget costs nothing but patience.

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

## Development

```bash
npm run typecheck
npm run build
npm run dev -- "your task"
```

## License

MIT
