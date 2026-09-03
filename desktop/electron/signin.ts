import { app, BrowserWindow, session, shell, Session } from "electron";

/**
 * Signing in to ChatGPT, in a browser ChatGPT will actually accept.
 *
 * The old flow drove Playwright's Chromium: a CDP-controlled browser, launched
 * with automation switches, which Cloudflare challenges — and the challenge
 * cannot be completed by the person sitting in front of it, so sign-in was
 * impossible on a machine with no importable cookies.
 *
 * This window is an ordinary Chromium window instead. No automation flags, no
 * remote-debugging port, no driver attached, sandbox left on: the user types
 * into a normal browser and completes any Cloudflare check themselves, exactly
 * as they would in Chrome. Nothing here bypasses or spoofs anything.
 *
 * The session lives in its own persistent partition, so the login survives
 * restarts, and the resulting cookies are read through Electron's supported
 * `session.cookies` API rather than by decrypting another browser's storage.
 */

/**
 * What this window tells the world it is.
 *
 * Electron names itself in the default user agent — "Electron/33.4.11", and
 * the app beside it — and Google reads that as an embedded browser: it
 * either refuses the sign-in outright ("this browser or app may not be
 * secure") or treats every visit as an unrecognised device and demands
 * two-step verification. Users signing in with Google felt that as "it will
 * not let me in". Removing those two tokens leaves the honest Chrome user
 * agent of the Chromium that is genuinely rendering the page: same engine,
 * same version, nothing invented.
 */
function browserUserAgent(): string {
  const appToken = `${app.getName().toLowerCase()}/`;
  return app.userAgentFallback
    .split(" ")
    .filter((token) => {
      const lower = token.toLowerCase();
      return !lower.startsWith("electron/") && !lower.startsWith(appToken);
    })
    .join(" ")
    .trim();
}

/**
 * The same edit, applied to the header the user agent does not cover.
 *
 * Modern Chromium announces itself twice: in `User-Agent`, and again in the
 * `Sec-CH-UA` client hints, which are built from a brand list the user agent
 * string cannot reach. Electron puts itself in both. Stripping only the
 * first left the second still saying `"Electron";v="33"`, and a sign-in that
 * reads brands rather than the user agent — Google's does — went on refusing
 * the window as an embedded browser.
 *
 * What is left is Chromium, which is what is actually rendering the page. No
 * brand is added: the window does not claim to be Google Chrome, it stops
 * claiming to be an app.
 */
export function stripEmbedderBrands(value: string): string {
  const appToken = app.getName().toLowerCase();
  const brands = value
    .split(",")
    .map((brand) => brand.trim())
    .filter((brand) => {
      const lower = brand.toLowerCase();
      return !lower.includes('"electron"') && !lower.includes('"' + appToken + '"');
    });
  return brands.join(", ");
}

/** Apply it to every request the sign-in partition makes. */
function honestClientHints(ses: Session): void {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) {
      if (!/^sec-ch-ua(-full-version-list)?$/i.test(name)) continue;
      const value = headers[name];
      if (typeof value === "string") headers[name] = stripEmbedderBrands(value);
    }
    callback({ requestHeaders: headers });
  });
}

/**
 * Google's refusal, recognised so it can be explained.
 *
 * When Google decides a window is an embedded browser it does not fail — it
 * navigates to a page saying the browser may not be secure, and then sits
 * there. Without this the window simply never produced a cookie and the app
 * reported a timeout, which tells the user nothing about what to do next.
 */
export function isGoogleRefusal(url: string): boolean {
  return /accounts\.google\.com\/.*(signin\/rejected|disallowed_?useragent|deniedsigninrejected)/i.test(
    url
  );
}

/** Persisted so a signed-in profile stays signed in between launches. */
const PARTITION = "persist:chatgpt-auth";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const SESSION_COOKIE = "__Secure-next-auth.session-token";
/** Domains whose cookies belong to the session, not to the page. */
const SESSION_DOMAINS = ["chatgpt.com", "openai.com"];

/**
 * Is this the session token?
 *
 * ChatGPT splits it when it is too large for one cookie, and then the plain
 * name never appears at all — only `…session-token.0` and `.1`. Waiting for
 * the exact name meant a successful sign-in was never noticed: measured on a
 * real login, the jar held both chunks and no unsuffixed cookie.
 */
function isSessionCookie(name: string): boolean {
  return name === SESSION_COOKIE || name.startsWith(`${SESSION_COOKIE}.`);
}

function belongsToSession(domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  return SESSION_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
/** Long enough for a slow login plus a challenge; not forever. */
const DEADLINE_MS = 15 * 60_000;
const POLL_MS = 1_000;

export interface HarvestedCookie {
  name: string;
  value: string;
}

export interface SignInResult {
  ok: boolean;
  cookies?: HarvestedCookie[];
  /** Who signed in, read from the session that just authenticated. */
  account?: { name?: string; email?: string };
  /** Why it did not succeed: "cancelled" | "timeout" | an error message. */
  reason?: string;
}

/**
 * Hosts that are part of signing in, rather than somewhere the page merely
 * links to. Sign-in providers and Cloudflare's own challenge domain have to
 * stay in this window; a terms page does not.
 */
const AUTH_HOSTS = [
  "chatgpt.com",
  "openai.com",
  "auth0.com",
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "challenges.cloudflare.com",
];

function isAuthUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** A value of a few characters is a leftover, not a session token. */
function looksLikeToken(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length >= 20;
}

/**
 * Who just signed in, asked of the session itself.
 *
 * The alternative was waiting for the automation browser to answer the same
 * question after the first turn, which leaves the account panel saying
 * "ChatGPT account" until then — and says nothing at all if that browser is
 * having a bad day. This session has just authenticated, so it knows.
 */
async function readAccount(ses: Session): Promise<{ name?: string; email?: string } | undefined> {
  try {
    // Session.fetch carries this partition's cookies; net.fetch would not.
    const res = await ses.fetch("https://chatgpt.com/api/auth/session");
    if (!res.ok) return undefined;
    const json = (await res.json()) as { user?: { name?: string; email?: string } };
    const user = json?.user;
    if (!user?.name && !user?.email) return undefined;
    return { name: user.name || undefined, email: user.email || undefined };
  } catch {
    // Cosmetic: a missing name never blocks a working sign-in.
    return undefined;
  }
}

let openWindow: BrowserWindow | null = null;

/**
 * Open the sign-in window and resolve once ChatGPT has issued a session.
 *
 * Success is detected from the cookie jar rather than from the URL: the web
 * app routes through several pages after a login, and the session cookie
 * appearing is the only signal that means the account is actually signed in.
 */
export function runSignIn(parent: BrowserWindow | null): Promise<SignInResult> {
  // A second window would race the first for the same partition.
  if (openWindow && !openWindow.isDestroyed()) {
    openWindow.show();
    openWindow.focus();
    return Promise.resolve({ ok: false, reason: "already open" });
  }

  const ses = session.fromPartition(PARTITION);
  // Set on the session, so the identity providers' own popup windows — which
  // share this partition — introduce themselves the same way.
  ses.setUserAgent(browserUserAgent());
  honestClientHints(ses);

  const bounds = parent?.getBounds();
  const width = 520;
  const height = 720;
  const win = new BrowserWindow({
    width,
    height,
    // Centred over the app when there is one, so it reads as part of it.
    x: bounds ? Math.round(bounds.x + (bounds.width - width) / 2) : undefined,
    y: bounds ? Math.round(bounds.y + Math.max(24, (bounds.height - height) / 3)) : undefined,
    minWidth: 400,
    minHeight: 520,
    resizable: true,
    alwaysOnTop: true,
    title: "Sign in to ChatGPT",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      partition: PARTITION,
      // A plain browser context: no preload, no Node, sandbox on. The page
      // gets nothing from OnFlip, and OnFlip reads only the cookie jar.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  openWindow = win;

  return new Promise<SignInResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: SignInResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      timer = null;
      openWindow = null;
      if (!win.isDestroyed()) win.destroy();
      parent?.focus();
      resolve(result);
    };

    const startedAt = Date.now();

    timer = setInterval(() => {
      if (win.isDestroyed()) {
        finish({ ok: false, reason: "cancelled" });
        return;
      }
      if (Date.now() - startedAt > DEADLINE_MS) {
        finish({ ok: false, reason: "timeout" });
        return;
      }
      // Asked without a domain filter and narrowed here: the jar holds
      // chatgpt.com and openai.com cookies under several host spellings, and
      // a filter that misses one loses part of the session.
      void ses.cookies
        .get({})
        .then((jar) => {
          const mine = jar.filter((c) => belongsToSession(c.domain ?? ""));
          const signedIn = mine.some((c) => isSessionCookie(c.name) && looksLikeToken(c.value));
          if (!signedIn) return;
          // Carry the account cookies; the transport decides which of them
          // are its own to replay.
          const cookies = mine
            .filter((c) => looksLikeToken(c.value) || c.name === "oai-did")
            .map((c) => ({ name: c.name, value: c.value }));
          void readAccount(ses).then((account) => finish({ ok: true, cookies, account }));
        })
        .catch(() => {
          /* the jar is not readable yet; the next tick tries again */
        });
    }, POLL_MS);

    // The title bar is the only place this window can speak to the user
    // without touching the page, so it carries the guidance rather than
    // whatever ChatGPT or a challenge page happens to be called.
    win.on("page-title-updated", (e) => e.preventDefault());
    const setGuidance = (text: string) => {
      if (!win.isDestroyed() && win.getTitle() !== text) win.setTitle(text);
    };
    win.webContents.on("did-navigate", (_e, url) => {
      // A Cloudflare check is a normal part of signing in and is completed
      // here, by the user, exactly as it would be in Chrome. Saying so keeps
      // it from reading as a stuck window.
      setGuidance(
        /challenge|cdn-cgi/i.test(url)
          ? "Complete the security check to continue"
          : "Sign in to ChatGPT"
      );
    });

    // The user closing the window is a cancellation, not a failure.
    win.on("closed", () => finish({ ok: false, reason: "cancelled" }));

    win.webContents.on("did-navigate", (_e, url) => {
      if (!isGoogleRefusal(url)) return;
      finish({
        ok: false,
        reason:
          "Google would not accept this window as a browser. Sign in with your email and password instead, or use \"Use my browser\" to hand over the session from the browser you normally use.",
      });
    });

    win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      // Sub-frame failures are noise; only a failed main document matters.
      if (isMainFrame && url && url.startsWith("https://chatgpt.com") && code !== -3) {
        finish({ ok: false, reason: `could not load ChatGPT (${description})` });
      }
    });

    // Identity providers routinely run their consent step in a popup, and
    // that popup has to stay inside this partition: sent to the system
    // browser it would sign the user in over there, leaving this window
    // waiting for a cookie that is never coming. So auth windows open here,
    // as children sharing the session; only plainly informational links
    // (terms, privacy, help) are handed to the real browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAuthUrl(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 480,
            height: 660,
            alwaysOnTop: true,
            autoHideMenuBar: true,
            webPreferences: {
              partition: PARTITION,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });

    void win.loadURL(LOGIN_URL).catch((e: unknown) => {
      finish({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    });
  });
}

/** Forget the signed-in profile — used by an explicit sign-out. */
export async function clearSignIn(): Promise<void> {
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData().catch(() => {});
}
