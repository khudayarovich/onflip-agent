/**
 * The name of a service, for a sentence shown to a person.
 *
 * The renderer knows which service is running as an id on the status payload
 * — "chatgpt", "deepseek", "qwen" — and several labels need it spelled the way the
 * service spells itself. The engine has its own `providerLabel`; this is the
 * same table on the renderer's side of the bridge, which cannot import it.
 *
 * It used to answer ChatGPT for an id it did not recognise, on the reasoning
 * that a label is not the place to surface a config value and ChatGPT is what
 * an install with no provider set is running. Both halves were wrong. A
 * DeepSeek install showed "ChatGPT" on its own account bar, and this table
 * survived the first pass at that bug because there were two of these
 * helpers with opposite policies — the account bar was fixed and this one,
 * behind the sign-out prompt and a settings line, was not.
 *
 * So: the id itself when it is unrecognised, and null when there is no id at
 * all. Showing "deepseek-v2" is honest. Showing "ChatGPT" is not, and on an
 * app that has had real bugs crossing the two services it reads as the app
 * being confused about which account it is on.
 */
const LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  arena: "Arena",
};

export function serviceLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return LABELS[id] ?? id;
}
