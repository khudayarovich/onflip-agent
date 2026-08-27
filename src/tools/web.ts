import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition } from "../types";
import { err, denied, asBool, asNumber, clip } from "./util";

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

/**
 * Web search without an API key: DuckDuckGo's HTML endpoint, parsed for
 * titles, URLs and snippets. The redirect links carry the real URL in the
 * `uddg` parameter, which is what gets returned — the model should follow up
 * with `web_fetch` on whichever result looks right.
 */
export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and return titles, URLs and snippets. Use for current information, error messages, library docs, and anything you cannot know. Follow up with web_fetch on a promising result.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      max_results: { type: "number", description: "How many results to return (default 8, max 15)" },
    },
    required: ["query"],
  },
  async run(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return err("`query` must be non-empty");

    const decision = await ctx.requestPermission({
      kind: "network",
      tool: "web_search",
      subject: `search: ${query}`,
    });
    if (!decision.allow) return denied("Search", decision.reason);

    const limit = Math.min(15, Math.max(1, asNumber(args.max_results) ?? 8));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: {
            // The HTML endpoint answers browsers; a bot-shaped UA gets blocked.
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            accept: "text/html",
          },
          signal: controller.signal,
        }
      );
      if (!res.ok) return err(`Search failed: HTTP ${res.status}`);
      const html = await res.text();

      const results: { title: string; url: string; snippet: string }[] = [];
      const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const snippets: string[] = [];
      for (const m of html.matchAll(snippetRe)) snippets.push(stripTags(m[1]));
      let index = 0;
      for (const m of html.matchAll(linkRe)) {
        if (results.length >= limit) break;
        results.push({
          title: stripTags(m[2]),
          url: resolveDuckLink(m[1]),
          snippet: snippets[index++] ?? "",
        });
      }

      if (results.length === 0) {
        return err(
          "No results parsed. The search page may have changed or the query returned nothing — try different terms, or web_fetch a site you already know."
        );
      }
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`
      );
      return {
        output: lines.join("\n\n"),
        title: query,
        display: { kind: "text", lines },
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return err(ctx.signal.aborted ? "Search interrupted by the user." : "Search timed out.");
      }
      return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo wraps result URLs in a redirect; the real one rides in `uddg`. */
function resolveDuckLink(href: string): string {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    const real = url.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : url.href;
  } catch {
    return href;
  }
}

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Download a URL to disk, byte-for-byte. `web_fetch` is for reading text;
 * this is for assets — archives, images, binaries — which cannot survive the
 * text round trip. Treated as a file write, because that is what it is.
 */
export const downloadFileTool: ToolDefinition = {
  name: "download_file",
  description:
    "Download a URL to a local file, byte-for-byte (use for archives, images, and binaries — web_fetch is for reading text). Max 50MB.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      path: { type: "string", description: "Destination file path (relative to the working directory)" },
    },
    required: ["url", "path"],
  },
  mutates: true,
  async run(args, ctx) {
    const rawUrl = String(args.url ?? "").trim();
    const rawPath = String(args.path ?? "").trim();
    if (!rawUrl || !rawPath) return err("`url` and `path` must both be non-empty");

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return err(`Not a valid URL: ${rawUrl}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return err(`Unsupported protocol: ${url.protocol}`);
    }
    const target = path.resolve(ctx.cwd, rawPath);

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "download_file",
      subject: `download ${url.href}`,
      targetPath: target,
      detail: [`to: ${target}`],
    });
    if (!decision.allow) return denied("Download", decision.reason);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT * 4);
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(url.href, {
        headers: { "user-agent": "OnFlip/1.0 (+https://github.com/onflip)" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!res.ok) return err(`Download failed: HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) {
        return err(`File is ${Math.round(buf.length / 1024 / 1024)}MB, over the 50MB limit.`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      const kb = Math.max(1, Math.round(buf.length / 1024));
      return {
        output: `Saved ${kb}KB to ${target} (${res.headers.get("content-type") ?? "unknown type"}). Note: downloads are not covered by /undo.`,
        title: path.basename(target),
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return err(ctx.signal.aborted ? "Download interrupted by the user." : "Download timed out.");
      }
      return err(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};

export const WEB_TOOLS: ToolDefinition[] = [webFetchTool, webSearchTool, downloadFileTool];
