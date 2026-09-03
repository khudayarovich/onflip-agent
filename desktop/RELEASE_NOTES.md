# OnFlip Desktop 0.8.0

**Turns no longer stop half-way.** The agent now ends every turn with a closing block of its own — `done` with the final answer, or `ask_user` with a question only you can settle. A reply that carries neither is sent straight back to the model for correction instead of ending the turn. The old approach guessed from the wording of the reply ("I'll verify the build now…"), and every session found a sentence it had not seen, in English, Russian or Uzbek. That guessing is gone.

**Several times faster.** OnFlip reads ChatGPT's own reply stream through the browser and accepts a reply the moment ChatGPT reports it finished, instead of waiting for the page to go quiet. A three-step task that used to take minutes now takes under half a minute.

**Cut-off replies are handled.** A reply that hit ChatGPT's length limit is continued with ChatGPT's own control, or asked for again — never executed half-written.

**Sign-in and the first message.** The stored session is put into OnFlip's browser cleanly at every launch, so the first message of a session no longer lands on a logged-out page. A message whose request ChatGPT rejects (an expired session, a throttle, a server error) is reported within seconds with the reason, instead of a minutes-long "thinking" freeze.

**Throttling is waited out, not retried.** ChatGPT's "you are sending requests too often" limit is recognised and the app pauses, rather than reloading and opening fresh chats that make it worse.

Also: questions from the agent are shown as their own item in the chat; a fresh chat's first turn is typed instead of uploaded; per-turn statistics are written to the log (`scripts/turn-stats.js` reads them).
