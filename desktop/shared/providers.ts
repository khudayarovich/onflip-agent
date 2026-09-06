/**
 * The name of a service, for a sentence shown to a person.
 *
 * The renderer knows which service is running as an id on the status payload
 * — "chatgpt", "deepseek" — and several labels need it spelled the way the
 * service spells itself. The engine has its own `providerLabel`; this is the
 * same table on the renderer's side of the bridge, which cannot import it.
 *
 * An id nobody recognises answers with ChatGPT rather than with the raw id:
 * a label is not the place to surface a config value, and ChatGPT is what an
 * install with no provider set is running.
 */
const LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
};

export function serviceLabel(id: string | undefined): string {
  return (id && LABELS[id]) || LABELS.chatgpt;
}
