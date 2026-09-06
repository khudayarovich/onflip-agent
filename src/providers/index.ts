/**
 * The seam a provider plugs into.
 *
 * Everything that drives a chat service goes through here, so that the engine
 * names a provider rather than naming ChatGPT. Today there is one
 * implementation and this file is a straight re-export of it: the ChatGPT
 * driver is not moved, wrapped or edited, and `git diff src/chatgpt/**` is
 * empty for the commit that introduces this.
 *
 * That is the point of doing it in this order. The seam is the part that
 * touches the working provider, so it lands on its own, provably changing
 * nothing, before any second implementation exists to blame.
 *
 * When DeepSeek arrives this becomes a dispatcher — each export choosing an
 * implementation from `activeProvider()` — and the ChatGPT side of that
 * dispatch is still the same functions, called the same way.
 */
export * from "../chatgpt/browser-client";
export {
  activeProvider,
  providerStateDir,
  providerLabel,
  isProviderId,
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  type ProviderId,
} from "./id";
