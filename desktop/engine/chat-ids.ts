/**
 * The ChatGPT conversations a session owns, and so may delete with it.
 *
 * Deleting a session in OnFlip deletes the conversations it opened on
 * chatgpt.com — `is_visible: false`, which is ChatGPT's own delete. So what
 * gets written into `chatIds` is a list of things that will be destroyed,
 * and two things were landing there that must never be:
 *
 *  - The user's own chat. After "continue this chat", the driver's current
 *    conversation *is* the user's pre-existing thread, and every turn copied
 *    it in. Deleting the session then deleted a conversation OnFlip never
 *    made, contradicting the comment that promised attached chats were left
 *    alone.
 *  - Other sessions' chats. The driver's list of opened conversations covers
 *    the whole process and is never cleared, so each session inherited every
 *    chat any earlier session in the same window had opened.
 *
 * A turn now credits only the chats first seen during that turn, never the
 * attached one — and an attached id already in an older record is dropped.
 */
export function recordableChatIds(
  recorded: readonly string[],
  seen: ReadonlyArray<string | null | undefined>,
  seenBeforeTurn: ReadonlySet<string>,
  attached: string | undefined
): string[] {
  const out = recorded.filter((id) => id !== attached);
  for (const id of seen) {
    if (!id || id === attached || seenBeforeTurn.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
