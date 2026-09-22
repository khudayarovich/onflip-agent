import * as dns from "node:dns/promises";
import * as net from "node:net";

/**
 * Keeping the agent's own fetches on the public internet.
 *
 * `web_fetch` and `download_file` take a URL the model chose, with a method,
 * headers and a body it also chose — and under `full-auto` the network
 * permission is granted without a prompt, unlike a shell command, which still
 * meets the allowlist and the danger check. So this is the one capability
 * that reaches anywhere with nobody looking.
 *
 * What that reaches, unguarded, is every service bound to this machine and
 * every host on the network it sits in: `127.0.0.1:*`, a database on the LAN,
 * and `169.254.169.254`, where a cloud instance hands out its credentials to
 * anything that asks.
 *
 * Two honest limits on what this can promise:
 *
 *  - It is a *defence in depth*, not a boundary. The agent also has a shell,
 *    and `curl` there reaches the same addresses. The asymmetry is that the
 *    shell is gated and this was not.
 *  - A name that resolves to a public address here and a private one when
 *    the request is actually made — DNS rebinding — is not stopped by
 *    checking and then fetching. Closing that needs the connection pinned to
 *    the address that was checked, which Node's fetch gives no way to do.
 */

/** Why this address is off limits, or null when it is ordinary. */
export function blockedReason(ip: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return blockedReason(mapped[1]);

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0) return "an unspecified address";
    if (a === 127) return "a loopback address";
    if (a === 10) return "a private network address";
    if (a === 172 && b >= 16 && b <= 31) return "a private network address";
    if (a === 192 && b === 168) return "a private network address";
    // 169.254.169.254 lives here: the cloud metadata service, which hands
    // out instance credentials to whatever asks from the instance.
    if (a === 169 && b === 254) return "a link-local address, where cloud instance metadata lives";
    if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT address";
    if (a === 192 && b === 0) return "a reserved address";
    if (a === 198 && (b === 18 || b === 19)) return "a benchmarking address";
    if (a >= 224) return "a multicast or reserved address";
    return null;
  }

  if (net.isIPv6(ip)) {
    const h = ipv6Groups(ip);
    if (!h) return "an address that could not be read";
    const zeros = (from: number, to: number) => h.slice(from, to).every((g) => g === 0);
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    if (zeros(0, 8)) return "an unspecified address";
    if (zeros(0, 7) && h[7] === 1) return "a loopback address";
    // IPv6 forms that carry an IPv4 address, and reach it. The URL parser
    // rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a check that
    // only knew the dotted spelling let loopback, and 169.254.169.254, in.
    if (zeros(0, 5) && h[5] === 0xffff) return blockedReason(v4(h[6], h[7]));
    if (zeros(0, 6)) return blockedReason(v4(h[6], h[7]));
    if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return blockedReason(v4(h[6], h[7]));
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return "a local translation address";
    if (h[0] === 0x2002) return blockedReason(v4(h[1], h[2]));
    if ((h[0] & 0xfe00) === 0xfc00) return "a unique-local address";
    if ((h[0] & 0xffc0) === 0xfe80) return "a link-local address";
    if ((h[0] & 0xffc0) === 0xfec0) return "a site-local address";
    if ((h[0] & 0xff00) === 0xff00) return "a multicast address";
    return null;
  }

  return null;
}

/**
 * The eight 16-bit groups of an IPv6 address, with `::` expanded and a
 * dotted IPv4 tail folded into the last two. Null when it does not read.
 */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const b = dotted.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((g) => Number.parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Set to allow private and loopback destinations, for driving a local server. */
export function privateFetchAllowed(): boolean {
  const raw = process.env.ONFLIP_ALLOW_PRIVATE_FETCH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Why this host is off limits, or null.
 *
 * Every address the name resolves to has to be acceptable, not just the
 * first: a name with one public and one loopback record would otherwise pass
 * and then connect to whichever the stack preferred. A name that does not
 * resolve is left alone, so the caller reports the real DNS error rather
 * than this one.
 */
export async function hostBlockedReason(hostname: string): Promise<string | null> {
  if (privateFetchAllowed()) return null;
  const literal = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(literal)) return blockedReason(literal);

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(literal, { all: true });
  } catch {
    return null;
  }
  for (const { address } of addresses) {
    const reason = blockedReason(address);
    if (reason) return reason;
  }
  return null;
}

export class BlockedAddressError extends Error {
  constructor(url: URL, reason: string) {
    super(
      `Refused to fetch ${url.href}: ${url.hostname} is ${reason}. ` +
        "OnFlip only fetches public addresses, so a page cannot steer the agent into this machine or its network. " +
        "Set ONFLIP_ALLOW_PRIVATE_FETCH=1 if you are deliberately driving a local server."
    );
    this.name = "BlockedAddressError";
  }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** The same headers, less the ones that identify the caller to a host. */
export function withoutCredentials(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

/**
 * Fetch, checking every hop rather than only the one the model named.
 *
 * Redirects were followed by the runtime, so a public URL could bounce the
 * request into a private one after any check — which makes checking only the
 * first URL worth very little. Each hop is resolved and checked before it is
 * taken.
 *
 * The method is downgraded to GET on 301/302/303 exactly as a browser does,
 * because a POST body must not be replayed at a destination the caller never
 * named.
 */
export async function fetchPublic(
  target: URL,
  init: RequestInit,
  maxHops = 5
): Promise<Response> {
  let current = target;
  let options: RequestInit = { ...init, redirect: "manual" };

  for (let hop = 0; ; hop++) {
    const reason = await hostBlockedReason(current.hostname);
    if (reason) throw new BlockedAddressError(current, reason);

    const res = await fetch(current.href, options);
    if (!REDIRECT_STATUS.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    if (hop >= maxHops) {
      throw new Error(`Too many redirects (more than ${maxHops}) starting at ${target.href}.`);
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return res;
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`Refused to follow a redirect to ${next.protocol}//… — only http and https.`);
    }

    const method = (options.method ?? "GET").toUpperCase();
    if (res.status !== 307 && res.status !== 308 && method !== "GET" && method !== "HEAD") {
      options = { ...options, method: "GET", body: undefined };
    }
    // Credentials the model set were meant for the host it named. A browser
    // drops them when a redirect leaves that origin, and so does this.
    if (next.origin !== current.origin) options = { ...options, headers: withoutCredentials(options.headers) };
    current = next;
  }
}
