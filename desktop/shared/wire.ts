import { StringDecoder } from "node:string_decoder";

/**
 * Newline-delimited JSON-RPC between the electron main process and the engine
 * child, over the child's stdio.
 *
 * Every message is one line, prefixed with an ASCII record separator. The
 * prefix is what makes the channel safe to share with a process that might
 * also print: anything on stdout without the prefix is treated as noise and
 * surfaced as a log line instead of being parsed.
 */

export const RS = "\x1e";

export interface WireRequest {
  type: "req";
  id: number;
  method: string;
  params: unknown;
}

export interface WireResponse {
  type: "res";
  id: number;
  result?: unknown;
  error?: string;
}

export interface WireEvent {
  type: "event";
  event: string;
  data: unknown;
}

export type WireMessage = WireRequest | WireResponse | WireEvent;

export function frame(msg: WireMessage): string {
  return `${RS}${JSON.stringify(msg)}\n`;
}

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

/**
 * One end of the channel. Symmetric: both sides can send requests, respond,
 * and emit events — the engine asks the UI for approval decisions through the
 * same mechanism the UI uses to ask the engine to run a turn.
 */
export class Peer {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  onRequest: RequestHandler = async (method) => {
    throw new Error(`No handler for ${method}`);
  };
  onEvent: (event: string, data: unknown) => void = () => {};
  /** Non-protocol output that arrived on the channel (stray prints). */
  onNoise: (line: string) => void = () => {};

  constructor(private write: (chunk: string) => void) {}

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write(frame({ type: "req", id, method, params }));
    });
  }

  emit(event: string, data: unknown): void {
    this.write(frame({ type: "event", event, data }));
  }

  /** Feed raw bytes from the other side. */
  feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      if (!line.startsWith(RS)) {
        this.onNoise(line);
        continue;
      }
      let msg: WireMessage;
      try {
        msg = JSON.parse(line.slice(1)) as WireMessage;
      } catch {
        this.onNoise(line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  /** Fail every outstanding request; called when the other side dies. */
  failAll(reason: string): void {
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  private dispatch(msg: WireMessage): void {
    if (msg.type === "res") {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(new Error(msg.error));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.type === "event") {
      this.onEvent(msg.event, msg.data);
      return;
    }
    // req
    void this.onRequest(msg.method, msg.params)
      .then((result) => {
        this.write(frame({ type: "res", id: msg.id, result: result ?? null }));
      })
      .catch((e: unknown) => {
        this.write(
          frame({
            type: "res",
            id: msg.id,
            error: e instanceof Error ? e.message : String(e),
          })
        );
      });
  }
}
