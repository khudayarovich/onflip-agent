/**
 * How a service is spelled for a person, and what to do before it is known.
 *
 * The renderer learns which service is running asynchronously — `providerGet`
 * over IPC, or the engine's status — so there is always a first moment when
 * it has no answer. Every place that needed a name filled that moment with
 * the literal "ChatGPT", which is right on three installs out of four and a
 * plain lie on the fourth: a DeepSeek install showed "ChatGPT account" on its
 * own account bar at launch, and the sign-in window offered to sign in to
 * ChatGPT while opening DeepSeek's login.
 *
 * That mattered more than a cosmetic slip deserves, because OnFlip has had
 * real bugs where the two services genuinely crossed. A label that guesses
 * wrong is indistinguishable from the app being confused about which account
 * it is on, and it cost a bug report saying exactly that.
 *
 * So this returns null rather than a default. Naming no service is honest;
 * naming the wrong one is not.
 */
const LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  deepseek: "DeepSeek",
};

export function providerLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return LABELS[id] ?? id;
}
