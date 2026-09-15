import type { SessionCookie } from "../auth/access";
import {
  chooseTransport as chooseChatGptTransport,
  type Transport,
  type TransportChoice,
} from "../chatgpt/transport";
import { DeepSeekTransport } from "./deepseek/transport";
import { QwenTransport } from "./qwen/transport";
import { ArenaTransport } from "./arena/transport";
import { activeProvider } from "./id";

/**
 * Which transport this run talks through.
 *
 * The dispatch is one `if`, and it is deliberately the only place a provider
 * is chosen at run time. ChatGPT's branch calls the function that has always
 * chosen ChatGPT's transport, with the arguments it has always taken, so
 * every decision inside it — the API path, the cookie check, the reasons — is
 * unchanged and unreviewable-by-accident.
 *
 * The browser-driven services need none of those arguments. They carry no
 * bearer token and no cookie jar of OnFlip's; their session lives in the
 * browser profile a real Chrome signed in to, and the driver either finds it
 * there or does not.
 */
export function chooseTransport(auth: {
  accessToken: string;
  cookies: SessionCookie[];
  deviceId?: string;
}): TransportChoice {
  switch (activeProvider()) {
    case "deepseek":
      return { transport: new DeepSeekTransport(), reason: "DeepSeek browser profile" };
    case "qwen":
      return { transport: new QwenTransport(), reason: "Qwen browser profile" };
    case "arena":
      return { transport: new ArenaTransport(), reason: "Arena browser profile" };
    default:
      return chooseChatGptTransport(auth);
  }
}

export type { Transport, TransportChoice };
