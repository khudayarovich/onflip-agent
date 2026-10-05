# Provider reliability audit — 5 October 2026

This extends the [codebase audit](code-audit-2026-10-05.md) with a focused review
of DeepSeek, Qwen and Gemini. Repairs are included in OnFlip Desktop 0.10.71.
Provider quotas remain controlled by the service.

## Repairs

| Area | Previous failure | Result |
| --- | --- | --- |
| DeepSeek and Qwen completion | A reply deadline could return the partial text already on screen as a complete answer. | Deadline failures stop generation and reject the partial reply before the tool parser. Existing text-settled completion rules remain. |
| Fresh-chat settings | The transport applied settings before the driver navigated to the new chat. | Settings are applied after navigation. DeepSeek verifies its thinking toggle; Qwen verifies the selected model and fails visibly if it cannot select it. |
| Browser input | A truncated textarea value only produced a warning, then was sent. | Shortened requests are rejected without pressing Send. |
| Reply budgets | DeepSeek and Qwen used their own ten-minute default regardless of the saved reply timeout. | All four providers share the configured timeout helper. |
| DeepSeek pacing | Its rolling send window belonged to one process and disappeared on restart. | The nine-send/65-second local pacing rule uses the provider's shared, locked pacing history. This is OnFlip's conservative traffic rule, not a promised service quota. |
| DeepSeek HTTP errors | Refused completion requests were logged, then treated as silence. A full composer could trigger another Send after a 429. | HTTP status and Retry-After are recognized without waiting for the response body. Auth, throttle, service and invalid-request failures keep distinct codes, and a known refusal prevents the send fallback. |
| DeepSeek diagnostics | The selector census raced fresh-chat navigation. | It runs after the first successful turn, against a settled page. |
| Qwen recovery | A recovery resend bypassed pacing and could restore the default model. | Recovery paces chat creation and the resend, restores and verifies the requested model, and checks cancellation/cooldowns before submission. |
| Qwen page readiness | The model picker appears after the composer; a live cold-page check reported it missing. | Model selection waits for the picker to mount. Health checks also wait for controls before declaring a page mismatch. |
| Gemini stream integrity | Malformed events were skipped; EOF without a finish could return partial text. Non-success finish reasons could also return text for execution. | SSE frames are assembled across data lines and byte boundaries. Malformed events, missing finishes and blocked finishes fail. STOP succeeds; MAX_TOKENS remains explicitly truncated. |
| Gemini cancellation | A stalled stream could keep its reader; an early fetch abort lost its interruption code. | Stop and reply deadlines cancel the stream and release its reader. Explicit interruption stays distinct from a service timeout. |
| Gemini request errors | Invalid models/settings could be automatically resent. Catalogue failures lost quota codes and reset delays. | Invalid requests are fatal until settings change. Catalogue errors preserve their codes and full delays, including HTTP-date Retry-After. Conflicting wait hints use the longer delay. |
| Gemini model discovery | Only the first catalogue page was read. | Pagination is followed before filtering/sorting. Repeated page tokens or excessive pages fail instead of replacing the cache with an incomplete list. |
| Gemini key verification | A service outage looked like an invalid key. | A 5xx/network failure leaves the key unverified; authentication rejection and an accepted-but-throttled key remain distinct. |
| Gemini thinking | All models received the 2.5 budget format; “Instant” could promise disabled thinking on models that cannot disable it. | Known 2.5 models use budgets and 3 models use levels. The minimum supported effort is used when thinking cannot be disabled. The English, Russian and Uzbek UI labels say “Minimum”; aliases and unknown families offer service defaults. |
| Gemini short quota waits | Only one transport waited, while other windows could send into the same quota. | Short waits persist a provider cooldown. Other windows stop before making a request; Stop cancels the scheduled retry. |
| Windows shared persistence | A temporary EPERM while opening/reading a deleting lock file abandoned a configuration update. | Lock acquisition and recovery treat Windows deletion contention as busy and retry before the transaction starts. |

## Verification

The new regressions in `test/provider-reliability.test.js` and
`test/gemini-reliability.test.js` exercise the real send loops with fake
Playwright contexts and SSE responses. An unarranged browser launch fails the
test, and no fixture can send a real provider request. A separate child process
checks that DeepSeek's rolling window survives an engine restart.

Local Windows checks: `npm test` discovered 1,617 tests: 1,613 passed, four were skipped,
and none failed. Engine and desktop typechecks, the desktop Node/UI production
build, and `git diff --check` passed. The Windows contention regression also
checks lock opening, recovery opening and reading under an injected transient
EPERM. The full suite includes the previous audit's fixes.
Ten six-process stress trials preserved all 3,600 counted configuration updates;
before the repair, the same workload lost updates when Windows reported a lock
as temporarily inaccessible. Genuine read-only folder errors retain their code
so best-effort persistence and local pacing continue to work.

Live read-only Gemini checks accepted the saved key and returned 15 filtered
chat models, including the 3.8 Flash family. These checks do not prove generation
entitlement or available generation quota. Live DeepSeek and Qwen browser checks
confirmed signed-in profiles and inspected the current page controls. The Qwen
check exposed the delayed picker and was repeated after fixing readiness. No
generation was requested from any provider. Qwen selected the requested Max
model successfully, and its original model was restored afterward. Live reply extraction, full tool
turns, installer execution and macOS paths were not exercised.

Google's primary documentation was checked for
[thinking controls](https://ai.google.dev/gemini-api/docs/generate-content/thinking),
[finish reasons](https://ai.google.dev/api/generate-content), and
[model pagination](https://ai.google.dev/api/models).

## Further improvements

1. Add one diagnostics view showing the selected model, last provider error,
   cooldown reset time, send/recovery counts and whether sign-in was actually
   verified. Existing logs contain much of this but leave users to infer it.
2. Maintain recorded browser DOM fixtures for DeepSeek and Qwen alongside the
   driver regression tests. Actual service redesigns still need a signed-in
   smoke test; simulated pages cannot prove that selectors match today's page.
3. Expose Gemini token usage and optional per-session cost/budget controls.
   The transport already records token counts, but users cannot yet use those
   numbers to manage spending in the app.
4. Add an explicit provider verification workflow before each release: sign-in,
   model selection, one text-protocol tool turn, Stop, resume, compaction, and
   account switching. This audit strengthens failures and retries but does not
   certify every live provider flow.
