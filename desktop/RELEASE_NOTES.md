# OnFlip Desktop 0.8.4

**macOS builds are back on every release.** Each release now carries the Windows installer and the macOS apps (`.dmg` and `.zip`, Apple Silicon and Intel), built together from the same tag. The Mac app is ad-hoc signed, not notarised: the first launch needs right-click → Open.

Everything from 0.8.0 to 0.8.3 is included:

- A refusal dressed as a question — "please reconnect the OnFlip tools" — no longer ends the turn; it is answered like a reply with no block.
- Desktop notifications when a task finishes, needs your approval or asks a question while OnFlip is in the background.
- Turns end on the agent's own `done` / `ask_user` block; a reply without one is sent back for correction instead of ending the turn half-way.
- Replies are accepted the moment ChatGPT's own stream reports them finished, so multi-step tasks run several times faster.
- The session is put into OnFlip's browser cleanly at every launch; rejected or throttled requests are reported within seconds instead of a minutes-long freeze.
