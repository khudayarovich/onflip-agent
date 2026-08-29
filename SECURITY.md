# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/khudayarovich/onflip-agent/security/advisories/new)
rather than in a public issue.

Include what an attacker could do, the steps to reproduce it, and the version
you tested. You will get an acknowledgement within a few days. Please give a
reasonable window for a fix before disclosing publicly.

## What OnFlip holds

Understanding this makes it easier to judge whether something is a
vulnerability:

- **Your ChatGPT session** — cookies and any access token — is stored in
  `~/.onflip/config.json` with owner-only permissions, and is sent only to
  ChatGPT.
- **Session transcripts** are plain JSON under `~/.onflip/sessions/`, including
  the prompts you sent and the tool output the agent saw.
- **Logs** under `~/.onflip/logs/` record message shapes, and at debug level
  full payloads.
- **The agent's browser profile** lives under `~/.onflip/` and holds whatever
  sites the agent signed in to.

There is no OnFlip server, no telemetry, and no account system. Nothing leaves
your machine except the conversation OnFlip sends to ChatGPT through your own
session.

## The agent runs code on your computer

That is the point of it, and it is also the main risk. The approval layer is
the boundary: **Read-Only** and **Ask First** put you in front of every side
effect, while **Full-Access** and **Unrestricted** do not. Treat prompts,
web pages and file contents the agent reads as untrusted input — a page can
try to talk the model into running something. Reports of the approval layer
being bypassed are exactly the kind of issue worth sending privately.

## Scope

In scope: anything that leaks the stored session, escapes the approval policy,
executes code without approval in a mode that should have asked, or lets a
remote page reach the local filesystem.

Not in scope: the fact that permissive approval modes run commands as intended,
and the fact that an unsigned build warns on Windows and macOS.
