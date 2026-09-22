/**
 * What the composer holds once text is handed back into it: a message
 * taken back to edit, a queued one taken out of the queue, a send the engine
 * refused, an undelivered message recovered after a restart, a skill.
 *
 * Each of those replaced whatever was in the composer, so the words being
 * typed at the moment Edit was clicked were simply gone. Both are kept now:
 * the recalled text, then what was being typed. Text that is already the
 * recalled message, or nothing but whitespace, is not kept twice.
 *
 * Applying it twice changes nothing, which matters: React's StrictMode,
 * which the renderer runs under, calls an effect twice in development.
 */
export function withDraft(current: string, recalled: string): string {
  const typed = current.trim();
  if (!typed || typed === recalled.trim()) return recalled;
  if (!recalled.trim()) return current;
  if (current.startsWith(`${recalled}\n\n`)) return current;
  return `${recalled}\n\n${current}`;
}

/** The files staged after a recall: the recalled message's, then any already staged, once each. */
export function withDraftFiles(staged: string[], recalled: string[] | undefined): string[] {
  if (!recalled?.length) return staged;
  return [...new Set([...recalled, ...staged])];
}
