# onflip-agent

OnFlip is a CLI coding agent whose model backend is a **ChatGPT web session** driven through Playwright, rather than an API. Written in TypeScript, compiled to CommonJS, run as `node dist/index.js`.

## Commands

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm run dev -- "…"  # tsx src/index.ts, no build step
node dist/index.js  # run the built CLI
```

There is no test runner wired up. Behaviour is verified by driving the built modules directly — see "Testing" below.

## Architecture

```
src/
  index.ts          entry point; signal handling and terminal restoration
  cli.ts            argument parsing, subcommands (login/status/sessions/config)
  repl.ts           the interactive session: state, slash commands, editor handoff
  config.ts         ~/.onflip/config.json
  models.ts         model slugs and the reasoning-effort directive
  types.ts          shared tool/message types

  agent/
    system.ts       system prompt construction
    protocol.ts     tool-call parsing, turn prompt assembly
    run.ts          the agent loop
    permissions.ts  approval policy and destructive-command detection
    context.ts      AGENTS.md discovery, git and environment snapshot
    store.ts        session persistence

  chatgpt/
    transport.ts    Transport interface; browser vs api selection
    browser-client.ts  Playwright automation of chatgpt.com
    client.ts       backend-api fallback

  tools/            read/write/edit/list/glob/grep, bash, todo, web_fetch
  ui/               theme, ansi, markdown, diff, render, editor, prompt, keys
  auth/             browser cookie extraction (Chromium DPAPI + Firefox)
```

### Things that are not obvious

**The model is not trustworthy about its own environment.** ChatGPT has a sandbox, a code interpreter and browsing. Left alone it will run your command *there* and report the output as if it came from the user's machine. `agent/system.ts` spends most of its length closing this off, and `detectFabrication` in `agent/run.ts` catches replies that claim execution without a tool call and asks for a retry. Do not weaken either without a replacement.

**The tool protocol avoids escaping on purpose.** The documented form is a fenced ```` ```onflip ```` block of `key: value` lines, with `key: |` plus an indented body for anything multi-line. There is no JSON to escape, because asking a chat model to JSON-escape a shell command reliably fails: `-Filter "DriveType=3"` breaks the string, the call does not parse, and the raw blob gets shown to the user as if it were an answer. JSON, `<onflip:tool>` tags, bare objects, alternate key spellings and double-encoded argument strings are all still accepted — a model that has seen a thousand JSON tool schemas will reach for them anyway — but the prompt steers hard toward the block form.

**The fence is not decoration.** Replies are read back out of rendered HTML, and the Markdown renderer *consumes* characters on the way in: an unfenced `$_.Size` becomes an `<em>` and the underscores are gone. `EXTRACT_MESSAGE` in `browser-client.ts` walks the message DOM and re-serialises it — code blocks verbatim from their `<code>` element, and `_`/`` ` ``/`**` put back around emphasis, inline code and bold. Never replace it with `innerText`.

**Never let user-facing copy leak into the system prompt.** `APPROVAL_DESCRIPTIONS` is written for CLI help, where the implied subject is OnFlip — "ask before every write and command". Reused verbatim in the prompt, the subject reads as *the model*, and it complies: "approve this and I'll run it", turn over, nothing executed. `APPROVAL_MODEL_GUIDANCE` exists as a separate, model-facing set that names OnFlip as the actor. `detectPermissionRequest` in `agent/run.ts` is the backstop.

**"I can't run that tool in this turn" is a refusal, not an answer.** `detectToolDenial` looked for the model claiming the tools were missing, unavailable or unexposed. Live, the model instead conceded they exist and declined to use them on the message in front of it — "I'm sorry, but I can't execute the local file-editing tool in this turn" — which matched nothing, was printed to the user as the answer to "update the game name", and left the file untouched. It now also catches a *named* tool behind `can't`/`unable to`, and "from this chat" widened to any of turn, message, thread or context. The system prompt and the per-turn reminder both say it outright, because the correction is cheaper never to need: the tools belong to the conversation rather than to a message, so there is no turn on which they cannot be called.

**A reply with no tool call *is* the end of the turn, and the model does not always know it.** Live: after four failed edits it answered "The previous patch mangled the declaration indentation; I'll restore it from the actual file and rebuild" — and stopped, mid-repair, with the file still broken, until the user typed "continue" to make it do the thing it had just promised. None of the other detectors could see it: nothing false was claimed, so not fabrication; nothing was asked for, so not a permission slip; and it happened *after* tools had run, which is exactly where fabrication detection stops looking. `detectAbandonedTurn` catches first-person future tense in front of a tool-shaped verb, in a short reply. The exclusions carry the weight — "I'll leave that to you", "I'll wait for your call", "you'll need to install Go" are all correct ways to end a turn — and it is held back after a denial for the same reason `detectPermissionRequest` is.

**Fabrication detection only applies before anything has run.** Once `executedCalls > 0`, "I ran the build and it failed" is an accurate summary rather than an invention — flagging it there would reject the closing answer of almost every successful turn.

**A call that fails to parse is not an answer.** `parseTurn` sets `malformed` when a reply clearly attempted a tool call, and the loop turns that into a correction and a retry. Once retries are exhausted it raises an error — it must never fall through to `onFinal`, or the user gets a broken tool call presented as their answer.

**Newlines are the fragile part of the round trip, in both directions.** Outbound, the composer treats Enter as "send", so anything that turns newlines into key presses either drops them or fires the message early; `typeMessage` therefore tries a synthetic paste event first, then `insertText`, then `fill`, and verifies the *line count* it got back — a character-only check passes happily on a payload whose newlines were all flattened. Inbound, `parseCollapsedBlock` recovers a block whose line breaks were lost anyway: the format is ordered, so the tail after `key: |` is taken verbatim and only the head is split on key boundaries, which keeps colons inside a command safe. That recovery runs over text that may just be prose, so it demands a bare-identifier tool name and either arguments or a block marker before it believes what it found.

**Transports own their own send bookkeeping.** `BrowserTransport` appends to one live ChatGPT thread, so it tracks `sentThrough` and resends only what is new; `ApiTransport` replays everything. `buildTurnPrompt` includes assistant turns only when `fromIndex === 0` — replaying into a fresh thread needs them, appending to a live one must not repeat them.

**Raw mode is acquired once per session, and handler ownership is separate from it.** `beginKeyboardSession()` puts the terminal in raw mode when the composer starts and `endKeyboardSession()` gives it back at shutdown; nothing in between touches the tty. `captureKeys` only swaps which handler receives keys, returning a disposer that restores the previous one — that is what lets an approval prompt interrupt the composer mid-turn and hand control back.

This split matters. An earlier version reference-counted raw mode alongside handler ownership, so every submit, prompt and agent turn dropped raw mode and re-entered it — fourteen tty transitions in a short session. Windows consoles do not survive that: `pause()` detaches the underlying read request and re-arming it can silently fail, after which keystrokes stop reaching the process until something else nudges stdin. The symptom was a composer that ignored typing until you pressed enter. Never call `setRawMode` or `stdin.pause()` directly, and do not reintroduce per-consumer tty toggling.

**The screen is three regions and only one of them scrolls.** `setHeader` and `setChrome` are painted at absolute rows on every frame; the transcript viewport gets whatever is left. Neither pinned region may take the whole screen — a very short terminal still has to show a line of transcript — and the scrolled-up hint gets its own row rather than being painted over the transcript, because a hint that hides the line you scrolled up to read is working against itself.

**Staying put while scrolled takes arithmetic.** `scrollOffset` is measured from the *end* of the transcript, so appending output moves the end and drags the text under the reader's eyes a row at a time — the position looked preserved and was not. `write` grows the offset by the number of lines committed, and shrinks it when the `MAX_TRANSCRIPT` trim drops lines off the front.

**The wheel has to be asked for, and it arrives as keystrokes.** The alternate screen has no scrollback, so the wheel does nothing there by default and the session *looks* unscrollable however well the keyboard scrolls it. `captureWheel` enables SGR mouse reporting (`?1000h` plus `?1006h`); the reports then come through the keypress decoder as escape sequences and would be typed into the composer as garbage, so `installDecoder` intercepts anything starting `ESC[<` — buffering it, since a report can be split across events — and never passes it on. Reporting is turned off in `endKeyboardSession`, which the crash and signal paths already call.

**Full-screen mode inverts who owns the screen.** `ui/screen.ts` enters the alternate buffer, and from then on every `ui.*` write is captured into an in-memory transcript rather than appended to scrollback — the alternate buffer has none. The frame is assembled and written in one go (transcript viewport, transient status, composer chrome, absolute caret) to avoid tearing. `Editor.render` hands its block to `screen.setChrome` instead of writing at the cursor, and `clear()` becomes a no-op because the frame owner repaints everything. `screen.leave()` must run before any exit message, or it prints onto a buffer that is about to be discarded.

**In full-screen, a write with no trailing newline must still render.** `screen.write` buffers until a newline arrives, and anything that redraws in place — the spinner, with its `` and no `
` — would otherwise accumulate in that buffer and never be drawn at all. The symptom is not a missing spinner but an apparently frozen session. So the in-flight line participates in the viewport, and a `` truncates it rather than appending. Components that redraw in place should still prefer `screen.setStatus`, which owns its own row.

**A modal prompt is a region of the frame, not something drawn at the cursor.** `ui/prompt.ts` had its own `out()` writing straight to `process.stdout`. In full-screen that is writing behind the frame owner's back: `render()` repaints every row it knows about and erases below, so the approval prompt survived only until the next frame — and `ui.stopSpinner()`, which runs immediately before it, schedules one. It read as a prompt that never appeared until a keystroke redrew it; and that redraw counted `cursor.up(drawnLines)` from a caret the frame had parked inside the composer, so ↑/↓ erased the composer instead of the list. `screen.setOverlay` now gives the selector a region between the transcript and the composer, painted with every frame. Inline mode still draws at the cursor but lifts the composer out with `ui.pauseComposer`, which *detaches* the hook rather than only clearing it — `out()` schedules a redraw of its own, which would otherwise repaint the box underneath the prompt half a tick later. The static half of the prompt goes through `emit` into the transcript, and the answer is echoed once the question comes down, or the transcript keeps the command and loses the decision.

**Anything persistent in the frame must be repainted when its state changes.** In inline mode `Editor.clear()` erased the composer and the agent's output took its place; in full-screen the composer is a permanent region, so `submit()` has to repaint it explicitly. Without that it keeps displaying the submitted prompt for the whole turn — which reads as a hang.

**The composer stays live for the whole turn, and that is what makes the queue possible.** `Repl.handleInput` pushes to `queue` instead of refusing while `busy`, and drains it after the turn; `esc` aborts the current `AbortController` without touching the queue, so an interrupt followed by a queued prompt is the "stop — do this instead" path. Two consequences worth keeping: the drain runs through `setImmediate` rather than recursing, or a long queue builds a stack the depth of its length; and `esc` while idle is the *only* thing that clears the queue, so an interrupt never silently discards what someone already typed.

**A persistent composer and an in-place spinner cannot share a row.** Once the box is drawn during a turn, `\r`-and-overwrite lands on top of the footer. `ui/render.ts` therefore routes the spinner through a `ComposerHook`: `setStatus` gives it a row of its own above the box, and only a session with neither a screen nor a composer falls back to writing at the cursor. Anything else that redraws in place needs the same treatment.

**A rule beats the mode, in both directions.** `evaluate` consults `matchBashRule` before it looks at `policy.mode`, so `{"rm *": "deny"}` holds under `yolo` and `{"git *": "allow"}` skips the destructive-command check. That ordering is the whole feature — a mode alone cannot express "run anything except this one thing", which is what people actually want when they hand over the shell. Rules are insertion-ordered and the *last* match wins, so `/permission` deletes a key before re-adding it; without that, restating a rule leaves it stuck behind an older catch-all.

**Waiting is not hanging, and the difference is the stop button.** `waitForReply` gives up on silence only when the page *also* shows no sign of working — while the stop button is up, ChatGPT is thinking, and only the overall budget should end that. An earlier flat 90-second no-text deadline cut off a high-effort rewrite mid-thought and reported "No reply from ChatGPT", which sends the user hunting for a broken selector instead of raising a budget. The two failures also carry different messages now, because they need different things done about them.

**The composer is not ready just because it is visible.** For a few seconds after a reply lands the box is still visible but not yet editable, and a click on it is swallowed — so `insertText`, which types into whatever holds focus, sends the whole payload into the page body and the send fails with "0 of N lines arrived". The tell was that it failed on the first attempt of every turn *after the first* and succeeded on the retry: a readiness problem wearing a layout problem's error message. `waitForComposerReady` waits for editable-and-not-generating, `clear()` verifies focus actually landed rather than assuming the click worked, and the strategy loop runs twice before giving up so a transient miss never costs a transport attempt.

**The model JSON-encodes a value when the value contains quotes.** Live: in one turn, every `edit` whose `old_string` held a double quote arrived as `"ctx.fillStyle = \\"#080b18\\";"` — quotes and backslashes and all — and every one that did not arrived raw. Nine of twenty-four edits failed to match the file. `coerce` now decodes a value that is a complete JSON string literal *containing backslash escapes*; the escapes are the signal. A value merely wrapped in quotes has none and keeps them, and a raw Windows path fails to parse and falls through untouched.

**Never send twice into a throttle.** ChatGPT answers overload and abuse checks with an HTTP error, and the worst possible response is another request. A live 403 — `{"detail":"Unusual activity has been detected from your device"}` — got retried twice, two and four seconds apart, because the no-retry guard matched on wording ("log in", "rate limit") that the real message does not use. `classifyFailure` in `chatgpt/backoff.ts` now sorts failures into retry / fatal / cooldown by status code as well as text, and a cooldown is persisted to config so restarting the CLI — the most natural reaction to a block — cannot walk straight back into it.

**The direct API path is the one that draws the flag.** Those requests go from Node with a bearer token and none of a browser's fingerprint or Cloudflare clearance. `chooseTransport` therefore never selects it on its own, only when `ONFLIP_TRANSPORT=api` asks for it: with no cookies the persistent browser profile is used instead, since it may well still be signed in and its failure mode is a fixable login rather than an account-level flag. The measured volume when the flag fired was 78 messages over 101 minutes — well inside any plan's limits — so it was the *shape* of the requests, not the rate.

**One unreadable browser is not a reason to stop looking.** `extractSessionTokenFromBrowser` walks every Chromium profile it can find and then Firefox. Chrome's app-bound encryption (v20) used to `throw` straight out of that loop, so Edge and Firefox were never reached — while the error it threw said "Try Firefox". A machine with a signed-in Firefox was indistinguishable from a machine with no session at all. Failures are now collected and the search continues; the v20 message is only raised if *nothing* worked, and it names the browsers that were tried rather than suggesting one of them. The readers are injectable so the search itself is testable without a filesystem full of browser profiles.

**The bundled Chromium is what Cloudflare challenges.** It is recognisably not a consumer browser, and the challenge it draws cannot be completed by the person sitting in front of it — so `onflip login --headed` was useless exactly when it was needed. `launchWithFallback` asks for the `chrome` channel first and falls back to the bundled build, which keeps machines without Chrome working for everything except the challenge.

**A message in the thread is a sign of life.** `waitForReply` gave up after 90 seconds of "no text and no stop button" — but the stop button is absent in the gap between submitting and generating, and with a reasoning model that gap runs long. A turn that was about to answer got abandoned and retried twice more, three failures over four and a half minutes on a conversation that was working. Once the user's own turn appears on the page, the send has landed and only the overall budget should end the wait.

**A failed cookie read must not end the session.** Browsers rotate their cookie encryption — Chrome's app-bound scheme especially — and `spawnExtractToken` throwing took down sessions that had a signed-in persistent profile and a valid stored token. It returns null now and the caller falls through. Two traps came with that: a stored "token" of four leftover characters is not one, and injecting it into a signed-in profile signs that profile *out*, so `looksLikeSessionToken` gates it; and once cookies can legitimately be empty, nothing downstream may read `cookies[0]` without a guard.

**Carry the session cookies, not the browser's.** `cf_clearance` and `__cf_bm` are issued against one browser and address; `GCLB`, `__cflb` and `__oailb` pin a backend. Replaying another browser's is useless at best and is the exact mismatch an anti-bot system exists to notice — measured, the page authenticated with them but never produced a composer, and did without. `NOT_OURS_TO_REPLAY` filters them at injection.

**Signing in through the automation browser is not a path.** Google's OAuth refuses automated browsers, and most accounts here are Google-linked, so `login --headed` cannot complete however friendly the browser looks. Every message that used to lead with it now leads with the cookie path: sign in normally, then `onflip login`.

**A chat is filed into a project after the fact, never started inside one.** `chatgpt.com/g/<project>/project` redirects to `/auth/login` with cookies that work perfectly on the ordinary chat page — project routes want a full sign-in, and that sign-in cannot be completed in an automated browser either, so the route is closed at both ends. `PATCH /backend-api/conversation/<id>` with **`gizmo_id`** moves a finished conversation using the same session that already lists projects — `conversation_template_id` is accepted with a 200 and silently ignored, which is how an earlier version reported success for every chat while leaving all of them outside. `fileIntoProject` re-reads the conversation afterwards and believes the read, not the status code. So `newChatUrl` knows nothing about projects, and `sendOn` files the conversation once it knows which one it is in.

**The URL is not a dependable way to learn which conversation you are in.** Seven chats out of twenty-five in `~/.onflip/logs` never showed `/c/<id>` at all, and every one of them silently skipped its filing — while the log recorded `filed: true`, because an unknown id compares equal to an unfiled chat. Two things follow from that. `resolveConversationId` falls back to the conversation listing and takes the one id the account has gained since `openNewChat` snapshotted it, which is exact and needs nothing from the page; with no snapshot it returns null rather than guess, because the cost of a wrong guess is moving a stranger's chat into someone's project. And anything reporting success has to test for the thing itself — `filed` now requires an id *and* a match.

**Superseded:** **A project is just a different URL to start the chat at, and only one form works.** `https://chatgpt.com/g/<short_url>/project` renders a composer; the bare `g-p-<id>` form loads a project page without one, so both forms are kept in config. A project URL takes no `?model=`, so a chat started in one uses the project's own model — that is a real limitation of the feature, not an oversight. What proves it worked is not the URL but `gizmo_id` on the conversation afterwards: that is the field the web UI groups on, and it is what decides whether a chat clutters someone's sidebar.

**The project has to be active before the first chat opens.** `setActiveProject` runs in `start()` right after the transport is chosen, because `openNewChat` fires on the first send — a setting applied any later would file one conversation in the main list on every startup, which is the exact complaint the feature exists to fix.

**Creating a project is `POST /backend-api/projects`, not the gizmo endpoint.** `POST /backend-api/gizmos` with `kind: "project_type"` returns 200 and a `g-` id — a plain GPT, silently not a project. The projects endpoint needs `name` *and* `instructions`, even empty. Check the returned id starts with `g-p-` before believing it.

**A service message is a failed send, and the transport has to be the one that knows.** `BrowserTransport` only sends what is new and marks the rest delivered with `sentThrough` — so when ChatGPT answers "Something went wrong", accepting that as a reply records a system prompt as delivered to a thread that never received it. Every turn afterwards sends only the newest user message into a conversation that has never heard of OnFlip, and it answers like the web app: measured, four turns of offering to format a Word document if the user would upload the spreadsheet OnFlip had just written to disk. `serviceMessage` lives in `chatgpt/backoff.ts` for that reason, and the transport throws on one *before* touching `sentThrough`; the agent loop keeps its own check for the paths that do not go through there.

**The composer has a size the transcript must stay under.** Measured: 60,831 characters typed in and answered normally; 112,586 could not be entered at all — "0 of 1016 lines arrived" — and the retry that did get in drew the error page above. That size only ever comes up on a full replay, which happens when the live chat is lost and `sentThrough` falls back to zero. So the defence is compaction, not truncation: `compactAfterChars` defaults to 60,000 to keep a replay inside what is known to work, and `MAX_PAYLOAD_CHARS` is the backstop behind it.

**ChatGPT's own messages arrive through the reply channel.** Image moderation, rate limits and error pages come back as ordinary assistant text and render as the agent's answer, which sends the user looking for a bug in OnFlip. `detectServiceMessage` attributes them, gated on a short reply so a long answer discussing one is not mistaken for being one. It adds a notice rather than suppressing the text — the reply is still what ChatGPT said.

**Attaching to an existing ChatGPT thread is asymmetric, and both halves fail silently.** The thread already holds the conversation, so resending it would duplicate a large payload; but it has never seen the tool protocol, so *not* sending that leaves the model answering in prose and never calling a tool. `BrowserTransport.adopt(n)` sets `sentThrough = n` and raises `needsSystemPrompt`, and `buildTurnPrompt`'s `includeSystem` option is what lets the system message ride along with a history that is otherwise skipped. If the live chat is later lost, `sentThrough` falls back to 0 and the whole transcript replays into a fresh thread — which is the right recovery, and only works because the imported messages were put into `history` rather than kept aside.

**A stringified evaluate function needs an argument to be called.** `page.evaluate("(el) => …", arg)` calls it; `page.evaluate("() => …")` with no argument evaluates the string as an *expression* and hands back the function itself. A first version of the conversation reader did the latter, so `roles` was undefined, the loop threw on the first index, the catch swallowed it, and every attach imported exactly zero messages while looking like it worked. Read per-node with `getAttribute` instead, or pass an argument.

**Opening a conversation works once per page, then bounces.** A `goto` to `/c/<id>` loads correctly on a page's *first* navigation; every one after it lands on `/` a moment later — whichever conversation, in whichever order, and a fresh tab in the same context does not help. Retrying the navigation, routing through the root first, and reloading were all tried and none of them work: something in the loaded app takes over routing. `openConversation` therefore retries by closing the browser and reopening it, which is slow enough to be worth avoiding and reliable enough to be worth doing. Verified by opening three conversations back to back.

**The attach's success signal is content, not the URL.** The URL reads `/c/<id>` for a second or so before the bounce, so checking it straight after `goto` says the wrong thing; a thread that came from the conversation list always has messages, so "settled with zero turns" is what actually means the attach failed. This matters beyond neatness — treating an empty page as a successful attach silently turns "continue this conversation" into "start a new one".

**`domcontentloaded` is nowhere near "the thread is on screen".** `settleTurns` polls until the turn count stops growing rather than sleeping a fixed interval — a live attach found zero messages after 1.2 seconds, and a long thread mounts progressively and would otherwise be read half-finished.

**Compaction has to be checked inside the loop, and measured in characters.** It ran once at the top of `runTurn`, so it could only ever see how big the transcript was *before* a turn — and a turn is where the growth happens: measured, one session ran 53 iterations and 98 tool calls, sent 219k characters, and compacted zero times, because every check found a transcript that had been small when the turn began. The trigger now runs before every send. The budget is `compactAfterChars` rather than a message count, because tool output is what fills a conversation: 127k of those 219k characters came from tool results, and one build log outweighs twenty exchanges. `compactIfLarge` returns `no-gain` when a summary failed to shrink anything, and the turn stops asking — otherwise a transcript that is over budget for some other reason spends the whole step budget summarising itself.

**A directory is the session boundary.** Sessions are stored and resumed per `cwd`, so `/open` starts a new one rather than carrying a transcript about one codebase into another where every path in it is wrong; `/cwd` exists for the other case — stepping into a subfolder of the same project — and keeps the session. Both go through `relocate()`, which has to move *all* of it at once: process cwd, shell cwd, project context, policy workspace, `session.cwd`, and the system prompt. Rebuilding the policy there must carry `bashRules` across; an earlier version dropped them, so changing directory silently revoked the user's own deny rules.

**Recent projects are derived, not recorded.** `recentProjects()` folds the session list by directory instead of keeping a separate recents file, so it cannot drift out of sync with `/sessions`. It orders by when each directory was last *worked in*, which is why a project you open and immediately leave does not jump to the top — nothing is written for a session until it has content. Directories that have since been deleted stay in the list, flagged, because a project that moved is what someone most needs explained.

**The editor redraws as a unit.** `ui/editor.ts` does not use readline's line editor, because the border, wrapped text, suggestion list and status footer have to move together. It tracks `drawnLines`, moves the cursor up and erases down on every keystroke.

**Enter submits; Tab completes.** Letting Enter accept a completion means finishing a command name and pressing Enter silently completes instead of running it, and the buffer quietly accumulates.

**The model list is not hardcoded.** `models.ts` ships defaults for a fresh install, but `onflip models --refresh` reads the account's real list through `chatgpt/models-api.ts` and caches it in config; `allModels()` prefers that whenever it exists. Do not "fix" a missing model by appending a slug to `BUILTIN_MODELS` — a wrong slug does not fail loudly, `?model=<slug>` quietly falls back to the default and the user believes they are on a model they are not. Unknown slugs pass through `normalizeModel` untouched by design, so a model newer than the build is still usable by name.

**A `page.evaluate` callback cannot see this module.** It is serialised and run in the browser, so a free variable from Node scope is a ReferenceError there — and one that only fires down the branch that mentions it. `backendApi` returned `{ __error: SIGNED_OUT_MESSAGE }` when the page had no token, so every signed-out-looking moment surfaced as `ReferenceError: SIGNED_OUT_MESSAGE is not defined` with a page stack, hiding the real diagnosis completely. Anything the page needs goes in through the argument object; anything the page reports comes back as data and is turned into a message on this side.

**An empty `/api/auth/session` is not a signed-out account.** It answers 200 with no `accessToken` while the app is still settling: measured on a working account, the first call or two after a browser launch come back empty and the next carries a token. Reading it once, from inside the page, made every cold start a coin flip — `/chats` needed two or three CLI restarts before it worked, which reads as a broken session rather than a race. `pageAccessToken` runs from Node so it can wait, backs off between tries, and reloads once on the third, because the two causes (a slow start, and a page that loaded before its cookies were in place) need different remedies. Everything that talks to `/backend-api` goes through it.

**Warming the session costs a page, not the good navigation.** `openConversation` depends on `/c/<id>` being a page's *first* navigation, so the session cannot be checked on that page beforehand — checking it means navigating. `warmSession` opens a throwaway page in the same context, which shares the cookies and establishes the same session, and closes it again. The failure message then distinguishes the two things a bounce can mean: without that, a session that was not ready yet was reported as a conversation that may have been deleted.

**A tool error has to be actionable, or it gets sent again unchanged.** "`old_string` matches 16 places" says the string is ambiguous and nothing about how to disambiguate it; "not found — whitespace must match exactly" does not say whether the text is wrong or merely indented differently. Both were re-sent verbatim, repeatedly, against a tab-indented Go file. `edit` and `multi_edit` now name the line numbers of every occurrence, and — the useful half — a string that fails to match is checked again with indentation ignored, so the error can say which line it is really on and what the file indents with. `indentInsensitiveMatches` is that check. A genuinely absent string still gets the plain message, because there is nothing better to say about it.

**Identical failing calls need naming as repetition.** The tool's own message is already in the transcript by the time the call is re-sent, so repeating it changes nothing. `runTurn` keeps a signature of every failed call — tool name plus arguments — and appends `repeatedCallAdvice` from the second attempt: it counts the attempts and gives the way out for that specific tool. Denied calls are excluded, because a refusal is the user's decision rather than a model loop, and the denial message already says what to do about it.

**The agent's browser is a second browser, and refs are its coordinate system.** `tools/browser.ts` drives its own persistent profile (`~/.onflip/browser-automation`), never the transport's — a stray navigation in that one ends the model conversation. The model cannot see, so pages are read through the accessibility tree: each snapshot tags visible interactive elements with `data-onflip-ref` and hands back numbered refs plus the page text, and every action answers with a fresh snapshot. Refs are cleared and reissued per snapshot on purpose — a stale ref must fail loudly ("call browser_snapshot") rather than silently click whatever now occupies the number. Two traps already paid for: `page.evaluate` of a stringified function is self-invoked (`(fn)(arg)`), because whether Playwright *calls* a string depends on heuristics and the failure is a silent undefined; and reading an element property through `locator.evaluate(string)` has the same problem — use `getAttribute`. Passwords are masked in the approval prompt by checking `type="password"`, and screenshots go under `~/.onflip/screenshots`, not the user's project.

**Diagnose from the log, not the terminal.** `src/log.ts` writes JSONL to `~/.onflip/logs/`: outgoing payload shape, the raw reply verbatim, parse outcome, and every tool call. Every hard bug in this project has been a transit problem invisible in the rendered output — a prompt flattened on the way out, a fence eaten on the way back, a placeholder mistaken for an answer. Failed parses log at *warn* with the full reply so a normal run leaves enough behind; `--debug` adds everything and echoes to stderr. When something misbehaves, read `onflip logs --full` before touching code.

**The model drops the fence and batches blocks.** Live behaviour, not theory: replies arrive as several unfenced `tool:` blocks separated by a bare `onflip` line the renderer left behind. `parseUnfencedBlocks` splits on each line-initial `tool:`; an unparseable line *ends* a block rather than voiding it. Anchoring on the first `tool:` and running to the end of the reply silently drops every call after the first.

**Scalars stay text.** `content: 2` is the string "2", not the number 2, and nothing in the syntax distinguishes them — so `coerce` converts booleans only, and tools normalise with `asNumber`/`asBool` from `tools/util`. A JSON array inside a `key: |` block is parsed, because that is how structured arguments actually arrive.

**Shipping it is not `npm publish` and not `npm i -g github:owner/repo`.** Both of the obvious paths are broken on current npm, and both fail in ways that look like the package's fault. npm runs a git dependency's `prepare` in a temporary clone *without* installing its devDependencies, so `tsc` is not on PATH and the install dies mid-build; and npm 11.17 no longer runs a package's install scripts on a global install unless it is named with `--allow-scripts=<pkg>`, repeated once per package — the comma-separated form is silently ignored. So the release artifact is the tarball from `npm pack`, which carries `dist/` already built, and `install.ps1` / `install.sh` download that from the GitHub Release and fetch the browser themselves rather than trusting `postinstall` to have run. `RELEASING.md` has the whole story; measure again before trusting any of it on a newer npm.

**A native dependency decides the Node floor.** `better-sqlite3` reads every browser's cookie database, so `onflip login` is nothing without it. v12 is the first line with prebuilt binaries for Node 20 through 26; on anything older the install falls back to `node-gyp` and needs a C++ toolchain, which turns "install easily" into "install Visual Studio Build Tools". That is the whole reason `engines.node` says `>=20` — not a language feature.

## Conventions

- Two-space indent, double quotes, semicolons, trailing commas.
- `strict` TypeScript. No `any` unless genuinely unavoidable; prefer `unknown` plus a narrowing check.
- Tool arguments arrive from a language model, so validate before use — never trust a shape.
- Comments explain *why*, not *what*. Prefer one paragraph above a subtle function over line-by-line narration.
- Errors returned to the model should say what to do next, and *where* — not just what failed. "Whitespace must match exactly" was the old advice here and it was not enough; see the note above about naming the line.
- Nothing user-facing goes through `console.log`; use the helpers in `ui/render.ts` so theming and width handling apply.
- Persistence is always best-effort: a read-only home directory must never take down a live session.

## Testing

Exercise the built modules directly with a scripted fake transport rather than a live ChatGPT session:

```js
const { runTurn } = require("./dist/agent/run");
const fake = { name: "api", async send() { return { content: nextScriptedReply, conversationId: null }; }, reset() {} };
```

The editor and REPL can be tested end to end by faking a TTY (`process.stdout.isTTY`, `process.stdin.setRawMode`), capturing `process.stdout.write`, and emitting synthetic `keypress` events on `process.stdin`. Stub `resolveAuth` and `chooseTransport` by assigning onto the required module object — TypeScript's CommonJS output accesses them as properties at the call site, so the patch takes effect.

Anything that draws — the composer, the full-screen frame, the spinner — is checked by replaying the captured bytes through a small virtual terminal rather than by regex over the output. Cursor arithmetic is exactly the kind of bug a substring assertion cannot see: the characters are all present, in the wrong places.

The same TTY fake driving the *real* transport is worth keeping for anything timing-shaped — queueing, interruption, a rule firing mid-turn. Those depend on a backend that takes tens of seconds and occasionally retries, and a stub that returns instantly proves none of it. Assert by polling the captured output until a marker appears, with a generous deadline, never with a fixed sleep. Seed and unseed any config a live run touches, since it uses the real `~/.onflip`.

A test harness that stubs `process.exit` must not then call anything that exits — `Repl.shutdown()` does — and should end with `process.reallyExit`.

## Gotchas

- Windows is a first-class target: `bash` shells out to PowerShell, and cookie decryption uses DPAPI.
- Chrome's app-bound cookie encryption (`v20`) cannot be decrypted. The fallback is `onflip login --headed` with a persistent Playwright profile.
- The browser transport's selectors are best-effort lists tried in order.
- **Reply completion is decided by the text, never by the page chrome.** `waitForReply` returns once the assistant text has stopped changing for `QUIET_MS`; a cleared stop button and a restored send button only let it return *sooner*. An earlier version required the stop button to disappear, and when that button lingered — or a selector as loose as `aria-label*='stop'` matched something else — there was no branch left that could fire, so a finished reply spun until the deadline. Any new completion signal must be an accelerator, not a precondition.
