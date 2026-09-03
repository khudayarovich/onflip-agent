import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition } from "../types";
import { err, denied, asBool, asNumber, clip, resolveIn } from "./util";

const FETCH_TIMEOUT = 30_000;
const MAX_BYTES = 2_000_000;

/**
 * Read a body without first holding all of it.
 *
 * `res.arrayBuffer()` buffers the whole response before a size check can
 * run, so a multi-gigabyte URL was pulled down in full and only then
 * refused. A declared Content-Length over the cap is refused before a byte
 * is read; otherwise the stream is consumed chunk by chunk and the request
 * aborted the moment it goes over. `bytes` is the declared size when the
 * server said one, null when the cap was hit mid-stream.
 */
async function readBodyCapped(
  res: Response,
  controller: AbortController,
  maxBytes: number
): Promise<{ buf: Buffer } | { tooLarge: true; bytes: number | null }> {
  const declared = res.headers.get("content-length");
  const expected = declared ? Number(declared) : NaN;
  if (Number.isFinite(expected) && expected > maxBytes) {
    controller.abort();
    return { tooLarge: true, bytes: expected };
  }
  if (!res.body) return { buf: Buffer.alloc(0) };
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      return { tooLarge: true, bytes: null };
    }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks) };
}

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
      const body = await readBodyCapped(res, controller, MAX_BYTES);
      if ("tooLarge" in body) {
        const size = body.bytes === null ? "Response is" : `Response is ${Math.round(body.bytes / 1024)}KB,`;
        return err(
          `${size} over the 2MB limit. Fetch a narrower URL, or download_file it and read the saved file in parts.`
        );
      }
      const { buf } = body;

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
    .replace(/&#(x[0-9a-f]+|\d+);/gi, numericEntity)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * `&#8212;` or `&#x2014;` as the character it names — by code point, since
 * fromCharCode cannot reach an emoji — or the entity itself if it names none.
 */
function numericEntity(entity: string, code: string): string {
  const n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
  try {
    return String.fromCodePoint(n);
  } catch {
    return entity;
  }
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
      const headers = {
        // The HTML endpoints answer browsers; a bot-shaped UA gets blocked.
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html",
      };
      // Two engines, tried in order. DuckDuckGo rate-limits a burst of
      // searches with an empty page — measured: six queries in one turn,
      // every one "No results parsed", while the same request from a quiet
      // process parsed ten results. One engine's throttle must not read as
      // "the web is down", so Bing catches what DuckDuckGo drops.
      let results: { title: string; url: string; snippet: string }[] = [];
      const engines: { url: string; parse: (html: string) => typeof results }[] = [
        {
          url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          parse: parseDuckDuckGo,
        },
        {
          url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
          parse: parseBing,
        },
      ];
      for (const engine of engines) {
        let res: Response;
        try {
          res = await fetch(engine.url, { headers, signal: controller.signal });
        } catch {
          if (controller.signal.aborted) throw new Error("aborted");
          continue;
        }
        if (!res.ok) continue;
        results = engine.parse(await res.text()).slice(0, limit);
        if (results.length > 0) break;
      }

      if (results.length === 0) {
        return err(
          "No results from either search engine. A burst of searches gets rate-limited — wait a moment before searching again, combine questions into one query, or web_fetch a site you already know."
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
function parseDuckDuckGo(html: string): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) snippets.push(stripTags(m[1]));
  let index = 0;
  for (const m of html.matchAll(linkRe)) {
    results.push({
      title: stripTags(m[2]),
      url: resolveDuckLink(m[1]),
      snippet: snippets[index++] ?? "",
    });
  }
  return results;
}

function parseBing(html: string): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []) {
    const link = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const para = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    results.push({
      title: stripTags(link[2]),
      url: resolveBingLink(link[1]),
      snippet: para ? stripTags(para[1]) : "",
    });
  }
  return results;
}

/**
 * Bing wraps every result in a /ck/a redirect carrying the real URL as
 * `u=a1<base64url>`. Returned decoded, because a redirect link tells the
 * model nothing about where it goes.
 */
function resolveBingLink(href: string): string {
  const clean = href.replace(/&amp;/gi, "&");
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(clean);
  if (!m) return clean;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* keep the wrapper if the encoding ever changes */
  }
  return clean;
}

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
    // Resolved like the file tools do, so `~/Downloads/x.zip` lands in the
    // home directory rather than in a folder literally named `~`.
    const target = resolveIn(ctx.cwd, rawPath);

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
      const body = await readBodyCapped(res, controller, MAX_DOWNLOAD_BYTES);
      if ("tooLarge" in body) {
        const size = body.bytes === null ? "File is" : `File is ${Math.round(body.bytes / 1024 / 1024)}MB,`;
        return err(
          `${size} over the 50MB limit. Nothing was saved; ask the user whether to fetch it with a shell command instead.`
        );
      }
      const { buf } = body;
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
