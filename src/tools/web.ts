import { ToolDefinition } from "../types";
import { err, denied, asBool, clip } from "./util";

const FETCH_TIMEOUT = 30_000;
const MAX_BYTES = 2_000_000;

/**
 * Fetch a URL and return it as readable text. The agent already runs against a
 * ChatGPT web session, but that session's browsing happens on OpenAI's side —
 * this tool fetches from the user's own network, which is what matters for
 * local dev servers, internal hosts and rate-limited APIs.
 */
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch a URL from the user's machine and return its content as text. HTML is reduced to readable text. Use this for docs, APIs, and local dev servers (http://localhost:...).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      method: { type: "string", description: "HTTP method (default GET)" },
      body: { type: "string", description: "Request body for POST/PUT/PATCH" },
      headers: { type: "object", description: "Extra request headers as a flat object" },
      raw: { type: "boolean", description: "Return the response body verbatim instead of extracting text" },
    },
    required: ["url"],
  },
  async run(args, ctx) {
    const raw = String(args.url ?? "").trim();
    if (!raw) return err("`url` must be non-empty");

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return err(`Not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return err(`Unsupported protocol: ${url.protocol}. Only http and https are allowed.`);
    }

    const method = String(args.method ?? "GET").toUpperCase();

    const decision = await ctx.requestPermission({
      kind: "network",
      tool: "web_fetch",
      subject: `${method} ${url.href}`,
      detail: [`host: ${url.host}`],
    });
    if (!decision.allow) {
      return denied("Request", decision.reason);
    }

    const headers: Record<string, string> = {
      "user-agent": "OnFlip/1.0 (+https://github.com/onflip)",
      accept: "text/html,application/json,text/plain,*/*",
    };
    if (args.headers && typeof args.headers === "object") {
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(url.href, {
        method,
        headers,
        body: typeof args.body === "string" ? args.body : undefined,
        signal: controller.signal,
        redirect: "follow",
      });

      const contentType = res.headers.get("content-type") ?? "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        return err(`Response is ${Math.round(buf.length / 1024)}KB, over the 2MB limit.`);
      }

      let text = buf.toString("utf8");
      if (!asBool(args.raw) && /text\/html/i.test(contentType)) text = htmlToText(text);

      const status = `HTTP ${res.status} ${res.statusText} · ${contentType || "unknown type"}`;
      return {
        output: `${status}\n\n${clip(text, 600, 60_000)}`,
        error: !res.ok,
        title: `${method} ${url.host}${url.pathname}`,
        display: { kind: "text", lines: text.split("\n").slice(0, 200) },
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return err(
          ctx.signal.aborted ? "Request interrupted by the user." : `Request timed out after ${FETCH_TIMEOUT}ms`
        );
      }
      return err(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

/** Crude but adequate HTML-to-text: drop non-content nodes, unwrap the rest. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export const WEB_TOOLS: ToolDefinition[] = [webFetchTool];
