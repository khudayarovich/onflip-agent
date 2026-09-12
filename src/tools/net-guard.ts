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
    const low = ip.toLowerCase();
    if (low === "::1") return "a loopback address";
    if (low === "::") return "an unspecified address";
    const head = Number.parseInt(low.split(":")[0] || "", 16);
    if (Number.isFinite(head)) {
      if ((head & 0xfe00) === 0xfc00) return "a unique-local address";
      if ((head & 0xffc0) === 0xfe80) return "a link-local address";
    }
    return null;
  }

  return null;
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
    current = next;
  }
}
