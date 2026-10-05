**OnFlip code audit — 5 October 2026**

Reviewed checkout: `79d96b07d9db9e3782b1bc60f60e606cb1bb5091`, desktop version `0.10.70`, Windows / Node `24.19.0`.

Eight code defects were confirmed with isolated reproductions against that checkout. All eight have now been repaired in this workspace. The findings below preserve the original audit evidence; their line numbers refer to the reviewed checkout. Account settings, browser profiles and dependencies were not changed.

**Repairs implemented**

| Finding | Result | Regression coverage |
| --- | --- | --- |
| 1. Truncated replies | Incomplete replies always stop before dispatch; exhausted retries raise an error. | Partial writes and closing blocks after truncation retries; exhaustion of the overall correction budget; a complete resend. |
| 2. Concurrent configuration | Cross-process locks cover fresh reads, patch merges and removals; selecting the longest cooldown is part of that transaction. | Four simultaneous engines preserve 48 updates, independent patches, removals and a four-hour cooldown; recovery of a dead engine's lock. |
| 3. Downloads | Capture the destination and every ancestor before approval; verify after fetching and before replacing a staged file. Binary contents are compared by SHA-256. | Concurrent edits during approval/download, Windows junction replacement, intact binary saving, failed replacement and cancellation. |
| 4. Long waits | Honor legitimate multi-hour/day waits, keep the minimum pause and reject values outside the supported date range. | Four-hour and next-day waits through coded/uncoded errors and browser errors; invalid huge headers. |
| 5. Shared pacing | Persist send and recent conversation times in each provider's `pacing.json`; claim slots under a shared lock, wait outside it and recheck cooldowns. Cancelled chats are not counted. | Simultaneous engines, a restarted engine, escalating conversation gaps, cancellation and a cooldown starting during a pacing wait. |
| 6. Missed schedules | Search the recent grace window first; historical runs only establish a missed occurrence. | A minute schedule resumes after three days and still avoids duplicate firing. |
| 7. Rejected updates | Validate a candidate schedule completely before changing the stored object. | Mixed valid/invalid updates preserve memory and disk; a subsequent valid update succeeds. |
| 8. Log errors | Handle asynchronous stream errors without ending the engine or clearing a newer log. | A real child process survives a failed open and successfully opens its next log. |

The model picker description now qualifies Luna access by plan terms and abuse safeguards. These changes address unnecessary bursts and premature retries; they do not control OpenAI's server-side safeguards. Pacing coordinates engines using the same config directory and provider; on a read-only filesystem it retains local pacing as a best-effort fallback.

**Luna and the early limits**

OpenAI's 6 August announcement does promise unlimited GPT-5.6 Luna text chats for Free and Go, subject to abuse guardrails. It explicitly keeps limits on uploads, images and other tools. OnFlip's built-in Luna is GPT-5.6 (`gpt-5-6-mini`). OnFlip's local tool calls and their returned results are chat text: they do not themselves use ChatGPT's built-in tool allowances. Follow-up messages and new conversations still contribute to traffic subject to abuse safeguards. [OpenAI announcement](https://openai.com/index/improving-gpt-5-6-sol-in-chatgpt/), [current ChatGPT usage guidance](https://help.openai.com/en/articles/20001354-gpt-56-and-gpt-6-pro-in-chatgpt).

GPT-6 Luna is a different case: OpenAI's launch places it in Work, Codex and the API, with desktop access for Free/Go; it is not yet in standard Chat. Current Work/Codex guidance estimates 350–3,000 local GPT-6 Luna messages per five-hour window for Plus and Standard Business, with allowance affected by task size and settings. Those estimates are not a guarantee, and weekly limits may also apply. [GPT-6 announcement](https://openai.com/index/introducing-gpt-6-sol-and-luna/), [Work/Codex allowance guidance](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex).

The available evidence explains several ways OnFlip can encounter an early block:

- A user request becomes many ChatGPT messages. Saved runs on versions 0.10.59–0.10.60 finished individual turns at 42, 49 and 41 iterations. The available post-0.10.55 sample has a median of 13 model round trips per completed user turn; it is a small, historical sample, not a benchmark for 0.10.70.
- One 0.10.59 log records 115 replies and 28 live-chat drops: 10 sends that did not land, 11 composer failures after reload, six resets and one empty attachment thread. These are extra recovery work, not 28 proven successful conversation creations. This history supports investigating recovery traffic rather than treating every block as a Luna message quota.
- A second log records 95 reply streams, of which 43 contain ChatGPT's own tool calls. Its server metadata reports `gpt-5-6-mini` for 91 streams and `gpt-5-6` for four. The hidden calls include `functions.exec`, connectors, web search and a container command. These do not establish which allowance was charged, but plain text prompts were not always answered using text alone.
- The stored ChatGPT configuration is Free, pinned to `gpt-5-6`, with a cached model list that labels both `gpt-5-6` and `gpt-5-6-mini` Luna and omits `reasoning_type`. The current active provider is Gemini, so this is historical ChatGPT state, not proof of what a current ChatGPT turn would use. Current startup code attempts to refresh that metadata and move known metered pins to the default.
- Findings 2, 4 and 5 below can lose or shorten a required wait and permit bursts across windows.

The current code already disables automatic context uploads by default, blocks Free/Go attachments, filters Work-only model slugs from the picker, and prefers the non-reasoning Luna variant when account metadata identifies it. Those protections exist; simply adding them again would not address the remaining defects. `src/models.ts:46` also overstates the verified promise as “unlimited text chat on every plan”; the official promise cited above is specifically scoped to Free/Go Chat and safeguards.

The retained logs do not contain a matching recent ChatGPT 429 or reset notice that proves the exact cause of the reported block. Their useful traffic samples predate 0.10.70. No live ChatGPT messages were sent during this audit.

**Original confirmed defects, before the repairs**

**1. [P1] Truncated replies become executable after the retry budget is spent.**

Location: [src/agent/run.ts:537](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/agent/run.ts#L537), immediately before tool dispatch at line 553.

The loop only rejects `meta.truncated` while its two truncation nudges and total nudge budget remain available. Once either budget is exhausted, it falls through to executing parsed calls and accepting closing blocks. A service-marked truncated response can contain a syntactically valid OnFlip block whose file body is incomplete.

Reproduction: a fake transport returned three identical `truncated: true` replies containing a write of `const unfinished = (`. The first two were rejected; the third wrote `truncated.js`. A subsequent `done` ended the turn successfully. Result: four sends, one executed write, incomplete JavaScript on disk. This affects ChatGPT and Gemini, both of which supply the flag.

Repair: always prevent execution and successful completion from a known truncated reply. If retries are exhausted, stop with a clear error and preserve the transcript. Test both exhausted truncation retries and exhausted total nudges.

**2. [P1] Concurrent config saves can erase a running cooldown.**

Location: [src/config.ts:590](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/config.ts#L590); callers include [src/chatgpt/backoff.ts:424](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/chatgpt/backoff.ts#L424).

`saveConfig` performs an unlocked read/merge/write. Atomic rename protects file integrity, but it does not make the transaction safe across processes. Each desktop window owns a separate engine, and the main process also writes settings. An unrelated save can overwrite a newer cooldown, model cache or setting with its older snapshot.

Reproduction: two actual child processes read the same starting config. The first saved a four-hour cooldown; the second then saved `thinking: "off"` using its stale snapshot. The final config contained the model and thinking setting but no `cooldownUntil`. This defeats the persisted no-send guard without a corrupted JSON file.

Repair: serialize config transactions across processes, reload within the lock, then merge and rename. Apply the same transaction discipline to `clearConfigKeys` and cooldown maximum selection. A main-process owner or a transactional store are alternatives.

**3. [P1] Downloads do not revalidate the approved write target.**

Location: [src/tools/web.ts:412](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/tools/web.ts#L412), final write at line 441.

Unlike the ordinary file editing tools, `download_file` captures no file/ancestor revision and performs no identity or content check after approval and network I/O. Replacing an approved parent directory with a junction or symlink changes where the final write lands. A user edit made while the download is pending can also be overwritten.

Reproduction: the requested destination was `approved/target.txt` inside a temporary workspace. During the approval wait, that directory was replaced with a Windows junction to a sibling directory holding existing `USER DATA`. The mocked download succeeded and changed the sibling file to `DOWNLOADED`. No external request or real user file was involved.

Repair: capture target and ancestor identity before approval, recheck after the download, and refuse changed destinations. Preserve the existing file on failure; use a temporary download plus a guarded replacement. Add coverage for directory-link swaps and concurrent file edits.

**4. [P2] Multi-hour service waits are shortened to one hour.**

Location: [src/chatgpt/backoff.ts:147](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/chatgpt/backoff.ts#L147), with the same clamp in the uncoded path at line 188.

The browser correctly calculates a usage reset time and passes it as `retry-after`, but `classifyFailure` caps it at 3,600 seconds. This is also shared by other providers. One hour is a plausible lower bound than many daily or tool resets, not a safe maximum.

Reproduction: at 08:00, the service notice said usage resets at 12:00 PM. `usageLimit` returned 14,400 seconds; classification returned 3,600. OnFlip's guard expires three hours early. The normal 15-minute automatic-resume ceiling means this example does not itself schedule an automatic retry, but manual sends are permitted too soon.

Repair: retain legitimate stated reset deadlines. Reject invalid/non-finite values rather than truncating valid long waits. Update the existing test that treats all long delays as absurd, and test ordinary four-hour and next-day resets.

**5. [P2] Request and new-chat pacing is per process, not shared across windows.**

Location: [src/chatgpt/backoff.ts:478](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/chatgpt/backoff.ts#L478) and line 536; separate engines originate at [desktop/electron/main.ts:603](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/desktop/electron/main.ts#L603).

`lastSendAt` and `newChatTimes` are module variables. Two windows on the same account each see their own first send/chat as unpaced and never include the other window's traffic in the trailing-hour count. Restarting an engine also resets the burst history. Thus the 1.5-second send floor and adaptive new-chat gap do not control aggregate account traffic.

Reproduction: two fresh engine-module processes each immediately passed send/new-chat pacing, reported one new chat, and independently reported the initial three-second gap. Neither observed the other's send or chat.

Repair: reserve send and new-chat slots atomically in shared state, scoped to provider/account, and retain recent chat creation history across engine restarts. Recheck cooldown after any pacing wait and before the outgoing operation. Test two engine processes together.

**6. [P2] A long shutdown makes a currently due frequent schedule look missed.**

Location: [desktop/electron/schedules.ts:236](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/desktop/electron/schedules.ts#L236), interpreted at line 218.

`lastDueBefore` advances through at most 2,000 occurrences from the previous run. After a longer interval it returns the 2,000th old occurrence rather than the most recent occurrence. `due` then marks it missed even when the current minute has a valid run. `runTick` advances `lastRunAt` to now, losing that current occurrence. A per-minute schedule crosses this limit after roughly 33 hours 20 minutes.

Reproduction: a per-minute schedule last active three days earlier was evaluated 15 seconds into a due minute. Result: zero runnable schedules and one missed schedule.

Repair: search for the most recent occurrence within the grace window, or skip older occurrences without abandoning the current one. Test a weekend shutdown and a schedule whose previous run predates more than 2,000 occurrences.

**7. [P2] A rejected schedule update still changes its cron expression.**

Location: [desktop/electron/schedules.ts:164](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/desktop/electron/schedules.ts#L164).

The cron field is mutated before the new prompt is validated. When the prompt is blank, the function returns `ok: false` without restoring the old cron. The scheduler uses the changed in-memory object immediately, and a later save can persist it.

Reproduction: update a 09:00 schedule with `{ cron: "0 10 * * *", prompt: " " }`. The call returned “Enter the prompt to send,” while `listSchedules()` reported a 10:00 schedule.

Repair: build and validate a candidate object before committing it, or restore every early return after mutation. Test mixed-field validation failures.

**8. [P2] Asynchronous logfile errors escape the logger's best-effort handling.**

Location: [src/log.ts:61](https://github.com/khudayarovich/onflip-agent/blob/79d96b07d9db9e3782b1bc60f60e606cb1bb5091/src/log.ts#L61) and line 99.

The logger catches synchronous calls but attaches no `error` handler to its `WriteStream`. Filesystem failures often arrive asynchronously, outside those `try` blocks. A consumer without a global exception handler exits; the desktop host catches uncaught exceptions globally, but the logger retains a failed stream and loses subsequent diagnostics.

Reproduction: in an isolated config directory, a directory occupied the intended `blocked.jsonl` path. Opening the logger and writing one event caused an unhandled `EISDIR`; the child process exited 1 before its “survived” marker.

Repair: handle stream errors, clear/disable the failed stream, and report the failure through a safe alternate channel without recursively logging to that stream. Test asynchronous open and write failures.

**Validation and dependency results**

| Check | Result |
| --- | --- |
| Engine TypeScript check | Passed |
| Desktop/main/renderer TypeScript checks | Passed |
| Root `npm test` after repairs | 1,577 discovered; 1,573 passed; 4 skipped; 0 failed |
| Baseline root `npm test` | 1,560 discovered; 1,556 passed; 4 skipped; 0 failed |
| Desktop Node build | Passed |
| Baseline explicit desktop test run | 429 passed; 0 failed |
| Desktop Vite production build | Passed |
| Root dependency audit | 0 reported vulnerabilities |
| Desktop production dependency audit | 0 reported vulnerabilities |
| Desktop audit including development dependencies | 4 high-severity package groups: `brace-expansion`, `fast-uri`, `http-cache-semantics`, `undici`; fixes available |

The root runner discovers desktop tests too, including the two added schedule regressions; the baseline 429-test run is not an additional 429 unique tests. Development dependency advisories warrant a separate lockfile maintenance pass, but they do not prove a vulnerability in the shipped desktop runtime. Dependency audit results are from the initial review, not a claim that dependency vulnerabilities are exhaustively known.

The initial scratch reproduction harnesses were written for the reviewed checkout's unlocked behavior and should not be rerun against these repairs. The permanent regressions are in [test/audit-fixes.test.js](../test/audit-fixes.test.js), [test/backoff.test.js](../test/backoff.test.js), [test/refused-request.test.js](../test/refused-request.test.js), [test/provider-rate-limits.test.js](../test/provider-rate-limits.test.js), and [desktop/test/schedules.test.js](../desktop/test/schedules.test.js). Run `npm test` from the repository root after building desktop Node modules. They use temporary directories, fake provider responses, and send no live ChatGPT messages.

This was a broad review of engine execution, protocol/context handling, model/plan selection, provider transports, permissions, file/network/shell tools, persistence, desktop IPC, scheduling, updates, Telegram and renderer boundaries. It is not a proof that every path is bug-free. Live provider DOM behavior, installed-app behavior, macOS-specific paths and installer execution were not exercised.

All eight code repairs are complete and built in this workspace. No installer was rebuilt and no running installed application was replaced. For any remaining rate-limit diagnosis, correlate the requested model with server `model_slug`, conversation request status/`Retry-After`, service reset text, hidden tool calls and recovery counts from the same updated-version run.
