# OnFlip Desktop 0.8.1

**First message after launch.** The session is put into OnFlip's browser cleanly at every launch — the profile's stale copies are cleared first and the new ones are set the way ChatGPT itself sets them — so the first page no longer comes up logged out with a request that never answers. If ChatGPT still serves a logged-out page, the new chat is reloaded once with the session put back, before anything else is tried.

**Requests that fail now fail fast.** A message whose request ChatGPT rejects (an expired session, a throttle, a server error) is reported within seconds with the reason and retried the right way, instead of a minutes-long "thinking" freeze.

Everything from 0.8.0 is included:

- Turns end on the agent's own `done` / `ask_user` block; a reply without one is sent back for correction instead of ending the turn half-way, whatever language the reply is in.
- Replies are accepted the moment ChatGPT's own stream reports them finished, so multi-step tasks run several times faster.
- Replies cut off at ChatGPT's length limit are continued or asked for again, never executed half-written.
- ChatGPT's "too many requests" throttle is recognised and waited out instead of retried.
- Questions from the agent are shown as their own item; a fresh chat's first turn is typed instead of uploaded; per-turn statistics are written to the log.
