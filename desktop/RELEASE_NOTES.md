# OnFlip Desktop 0.8.3

**A refusal dressed as a question no longer ends the turn.** The model sometimes closes a turn with an `ask_user` block that asks you to "reconnect" or "expose" the OnFlip tools, or with a `done` block that says the work could not be done without them — after using those very tools a moment earlier. Such a block is now read for what it is and answered with the tool roster, then with a demand for one harmless call, exactly like a reply with no block; only a real question or a real finish ends the turn.

Everything from 0.8.0 to 0.8.2 is included:

- Desktop notifications when a task finishes, needs your approval or asks a question while OnFlip is in the background.
- Turns end on the agent's own `done` / `ask_user` block; a reply without one is sent back for correction instead of ending the turn half-way.
- Replies are accepted the moment ChatGPT's own stream reports them finished, so multi-step tasks run several times faster.
- The session is put into OnFlip's browser cleanly at every launch; rejected or throttled requests are reported within seconds instead of a minutes-long freeze.
