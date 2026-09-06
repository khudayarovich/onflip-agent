# Architecture

OnFlip is three processes with one job between them: turn a sentence typed by a
person into work done on their computer, using a chat session — ChatGPT or
DeepSeek — rather than an API.

```
  Electron renderer            Electron main               engine (plain Node)
  ─────────────────            ─────────────               ───────────────────
  React UI, draws only  ──IPC──►  windows, dialogs,  ──ndjson──►  agent loop
  never touches disk    ◄──────   sign-in, terminal  ◄─ over ──   tools
                                                        stdio     approval policy
                                                                  provider seam
                                                                        │
                                                                  Playwright
                                                                        ▼
                                                          chatgpt.com · deepseek.com
```

## Providers

Two services, one agent. `src/providers/index.ts` is the only seam: everything
above it — the loop, the tools, the approval policy, the sessions — is the same
code whichever service is answering. Below it sit two drivers, one per service,
each with its own browser profile.

The seam answers rather than throws for anything a service does not have:
DeepSeek has no projects and no conversation list, so those come back empty and
a session keeps working. Only what would silently lose the user's work — asking
to *create* a project that cannot exist — refuses out loud.

Config is scoped the same way. ChatGPT keeps the top level of `config.json`,
where every install written before providers existed already put things; every
other service reads and writes under `providers.<id>`. A session token belongs
to ChatGPT alone and is filed there whichever service is running.

## Why the engine is a separate process

Three reasons, all learned rather than designed:

1. **Native ABI.** `better-sqlite3`, used to read browser cookies, ships
   bindings built for Node's ABI. Electron's differs. Running the engine under
   plain Node keeps that working, and the app carries a second binding
   (`prebuilds/`) for the fallback case where no system Node exists.
2. **Parity with the CLI-era core.** The engine assembles the same core the
   command line used to, so the agent behaves identically wherever it runs.
3. **Isolation.** A crash in the agent — or a browser it drives — takes the
   engine down, not the window. The shell notices and restarts it.

One window owns one engine. That pairing is what makes two windows two genuinely
concurrent sessions, each with its own working directory, browser and running
turn. What must be shared — the account session, the send cooldown — lives in
`~/.onflip`, which every engine reads.

## The transport

There is no API key, so there is no API. The engine drives a real browser
session:

- A message is typed into the composer, or — on ChatGPT, when it is too large
  to type — handed over as an uploaded file with a short pointer message.
  DeepSeek has no such upload path, so its ceiling is what the composer takes.
- The reply is read back out of the page and re-serialised to Markdown, because
  the rendered DOM has already eaten characters the agent needs (`$_` becomes
  emphasis, and the command no longer runs).
- Failures are classified before they are retried. A throttle starts a cooldown
  that outlives the process; a stalled generation is cut and retried in a fresh
  conversation; a composer that refuses the message is reloaded once before the
  thread is abandoned.

`src/chatgpt/backoff.ts` is where that classification lives, and its comments
carry the incidents that shaped it.

## The tool protocol

The model does not have native function calling here — it is a chat session. So
tools are a text protocol: a fenced ` ```onflip ` block with `tool:` and plain
`key: value` lines, or JSON in the same fence. The parser is deliberately
forgiving, because the page's Markdown renderer sometimes eats the fence and
models sometimes put arguments in the wrong place; every allowance in
`src/agent/protocol.ts` corresponds to a real reply that would otherwise have
been shown to the user as an answer.

Everything a tool does passes through `src/agent/permissions.ts` first.

## Context

A conversation is replayed to a fresh thread whenever one is opened, so
transcript size is a real cost. It is compacted into a handover brief when it
grows past a budget sized from the account's plan and the model's published
context window. The compaction trigger measures only what compaction can
reclaim — the system prompt survives it verbatim, and counting it once put
sessions into a compaction loop that ended in a rate limit.

## Sessions on disk

`~/.onflip/` holds everything: `config.json` (session, model, preferences),
`sessions/*.json` (transcripts, todos, file snapshots), `logs/*.jsonl` (one per
run), `scratch/` (workspaces for folder-less chats), and the browser profiles.
All of it is plain files, meant to be readable and deletable by hand.
