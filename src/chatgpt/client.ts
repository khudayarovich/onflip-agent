import { randomUUID } from "node:crypto";
import { ChatMessage, SendTurnResult } from "../types";
import { SessionCookie } from "../auth/access";

const BACKEND_URL = "https://chatgpt.com/backend-api/conversation";

interface ApiMessage {
  id: string;
  author: { role: string; name?: string | null };
  content: { content_type: string; parts: unknown[] };
  metadata: Record<string, unknown>;
}

function toApiMessage(m: ChatMessage): ApiMessage {
  return {
    id: m.id,
    author: { role: m.role },
    content: { content_type: "text", parts: [m.content] },
    metadata: {},
  };
}

export interface SendOptions {
  accessToken: string;
  model: string;
  conversationId?: string | null;
  parentMessageId?: string | null;
  cookies?: SessionCookie[];
  deviceId?: string;
  /** Reasoning effort for thinking-capable models: off | low | medium | high. */
  thinking?: string;
  onDelta?: (text: string) => void;
  /** Aborts the in-flight request when the user interrupts the turn. */
  signal?: AbortSignal;
}

export interface StreamEvent {
  type: "delta" | "message_id" | "conversation_id" | "done" | "error";
  text?: string;
  messageId?: string;
  conversationId?: string;
  error?: string;
}

interface StreamHandlers {
  onDelta?: (text: string) => void;
  onMessageId?: (id: string) => void;
  onConversationId?: (id: string) => void;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function getSentinelToken(
  accessToken: string,
  deviceId: string | undefined,
  cookies: SessionCookie[]
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "oai-language": "en-US",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "user-agent": UA,
  };
  if (deviceId) headers["oai-device-id"] = deviceId;
  if (cookies.length) headers["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  try {
    const res = await fetch("https://chatgpt.com/backend-api/sentinel/chat-requirements", {
      headers,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { token?: string };
    return data.token;
  } catch {
    return undefined;
  }
}

async function consumeStream(response: Response, handlers: StreamHandlers): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is empty");
  const decoder = new TextDecoder();
  let buffer = "";

  const handleData = (data: string) => {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (json.error) {
      const err = json.error as { message?: string };
      throw new Error(`ChatGPT backend error: ${err.message ?? JSON.stringify(json.error)}`);
    }
    const message = json.message as
      | { id?: string; conversation_id?: string; content?: { parts?: unknown[] } }
      | undefined;
    if (message) {
      if (message.id) handlers.onMessageId?.(message.id);
      if (message.conversation_id) handlers.onConversationId?.(message.conversation_id);
      const parts = message.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part === "string") handlers.onDelta?.(part);
          else if (part && typeof part === "object") {
            const obj = part as { text?: unknown; content_type?: string };
            if (typeof obj.text === "string") handlers.onDelta?.(obj.text);
          }
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          handleData(line.slice(5).trimStart());
        }
      }
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) handleData(line.slice(5).trimStart());
    }
  }
}

export async function sendTurn(
  messages: ChatMessage[],
  opts: SendOptions
): Promise<SendTurnResult> {
  const apiMessages = messages.map(toApiMessage);
  const last = apiMessages[apiMessages.length - 1];

  const body: Record<string, unknown> = {
    action: "next",
    messages: apiMessages,
    parent_message_id: opts.parentMessageId ?? last?.id ?? randomUUID(),
    model: opts.model,
    timezone_offset_min: -new Date().getTimezoneOffset(),
    history_and_training_disabled: false,
    conversation_mode: { kind: "primary_assistant" },
    force_paragen: false,
    force_rate_limit: false,
    suggestions: [],
    websocket_request_id: randomUUID(),
  };
  if (opts.conversationId) body.conversation_id = opts.conversationId;
  if (opts.thinking && opts.thinking !== "off") {
    body.reasoning_effort = opts.thinking;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${opts.accessToken}`,
    "oai-language": "en-US",
    "origin": "https://chatgpt.com",
    "referer": "https://chatgpt.com/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
  if (opts.deviceId) headers["oai-device-id"] = opts.deviceId;
  if (opts.cookies && opts.cookies.length) {
    headers["cookie"] = opts.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  const sentinel = await getSentinelToken(opts.accessToken, opts.deviceId, opts.cookies ?? []);
  if (sentinel) {
    headers["openai-sentinel-token"] = sentinel;
    headers["openai-sentinel-chat-requirements-token"] = sentinel;
  }

  const res = await fetch(BACKEND_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Request rejected (HTTP ${res.status}). Your session/access token may be invalid or expired. Try: onflip login\n` +
        `Server said: ${body.slice(0, 1000)}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backend request failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  let text = "";
  let messageId = "";
  let conversationId = opts.conversationId ?? "";
  await consumeStream(res, {
    onDelta: (d) => {
      text += d;
      opts.onDelta?.(d);
    },
    onMessageId: (id) => (messageId = id),
    onConversationId: (id) => (conversationId = id),
  });

  if (!text.trim() && !messageId) {
    throw new Error("Empty response from ChatGPT backend.");
  }

  return { content: text, messageId, conversationId };
}
