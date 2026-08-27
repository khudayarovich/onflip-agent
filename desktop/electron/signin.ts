import { BrowserWindow, session, shell } from "electron";

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

/** Persisted so a signed-in profile stays signed in between launches. */
const PARTITION = "persist:chatgpt-auth";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const SESSION_COOKIE = "__Secure-next-auth.session-token";
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
      void ses.cookies
        .get({ domain: "chatgpt.com" })
        .then((jar) => {
          const primary = jar.find((c) => c.name === SESSION_COOKIE);
          if (!looksLikeToken(primary?.value)) return;
          // Carry the account cookies; the transport decides which of them
          // are its own to replay.
          const cookies = jar
            .filter((c) => looksLikeToken(c.value) || c.name === "oai-did")
            .map((c) => ({ name: c.name, value: c.value }));
          finish({ ok: true, cookies });
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

    win.webContents.on("did-fail-load", (_e, code, description, url) => {
      // Sub-resource failures are noise; only a failed main document matters.
      if (url && url.startsWith("https://chatgpt.com") && code !== -3) {
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
