# OnFlip Desktop 0.8.2

**Desktop notifications.** While OnFlip is in the background — hidden, minimised or behind another window — a system notification tells you when a task has finished, when the agent has a question for you, when a tool call needs your approval, and when a turn stopped with an error. Clicking it brings the window forward. Worded in the interface language; switch it off under Settings → Appearance if you prefer quiet.

Everything from 0.8.0 and 0.8.1 is included:

- Turns end on the agent's own `done` / `ask_user` block; a reply without one is sent back for correction instead of ending the turn half-way, whatever language the reply is in.
- Replies are accepted the moment ChatGPT's own stream reports them finished, so multi-step tasks run several times faster.
- Replies cut off at ChatGPT's length limit are continued or asked for again, never executed half-written.
- The session is put into OnFlip's browser cleanly at every launch, so the first message no longer lands on a logged-out page; a rejected or throttled request is reported within seconds instead of a minutes-long freeze.
- ChatGPT's "too many requests" throttle is recognised and waited out instead of retried.
- Questions from the agent are shown as their own item; per-turn statistics are written to the log.
