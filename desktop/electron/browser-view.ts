import { app, BrowserWindow, WebContentsView } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The agent's browser, embedded in the window.
 *
 * It used to be a Chromium of Playwright's own, in its own OS window and its
 * own process, mirrored into the panel as a screencast — an `<img>` replaced
 * several times a second, with the user's clicks played back into the real
 * page as fractions of the frame. It worked, and it always looked like what
 * it was: a video of a browser. Text was soft, scrolling stuttered, and
 * hover did not exist at all, because there is no such thing as hovering a
 * screenshot. A cookie banner or a login field was something to watch.
 *
 * This is a real `WebContentsView` docked into the window instead. Chromium
 * composites it with the rest of the UI, so it is as sharp and as smooth as
 * any other browser tab, and every pointer event is a genuine one: hover
 * states, text selection, native scrolling, form focus.
 *
 * The agent still drives it with Playwright, unchanged. Electron is Chromium,
 * so the view answers the DevTools protocol like any page — Playwright
 * attaches over CDP and every existing browser tool works against it as-is.
 */

/** The engine finds its view by this, since CDP shows it every page. */
let viewMark = "";
/** Resolved after ready from Chromium's own record of the port it took. */
let endpoint: string | null = null;
/** One view per window; a window's view dies with it. */
const views = new WeakMap<BrowserWindow, WebContentsView>();

/**
 * Ask Chromium for a DevTools port, before it starts.
 *
 * Must run before `app.whenReady()` — a command-line switch appended after
 * Chromium has initialised is simply ignored. Port 0 means "take a free one
 * and write it down", which avoids both a hard-coded port and a race to find
 * a free one; the number lands in `DevToolsActivePort` under the user-data
 * directory, which is where `resolveEndpoint` reads it from.
 *
 * The socket is loopback-only, which is Chromium's default and not something
 * this passes an option to change.
 */
export function enableEmbeddedBrowser(): void {
  if (process.env.ONFLIP_EMBEDDED_BROWSER === "0") return;
  viewMark = randomBytes(9).toString("hex");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.ONFLIP_CDP_PORT ?? "0");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

/** The port Chromium actually took, or null if it never opened one. */
export function resolveEndpoint(): string | null {
  if (!viewMark) return null;
  if (endpoint) return endpoint;
  const fixed = process.env.ONFLIP_CDP_PORT;
  if (fixed && fixed !== "0") {
    endpoint = `http://127.0.0.1:${fixed}`;
    return endpoint;
  }
  // Chromium writes the port on its first line and a browser-wide GUID on the
  // second. Written at startup, so by the time a window exists it is there.
  try {
    const file = path.join(app.getPath("userData"), "DevToolsActivePort");
    const first = fs.readFileSync(file, "utf8").split("\n")[0]?.trim();
    if (first && /^\d+$/.test(first)) {
      endpoint = `http://127.0.0.1:${first}`;
      return endpoint;
    }
  } catch {
    /* no port file: the switch was refused, or this build has no DevTools */
  }
  return null;
}

/**
 * What the engine needs to find and drive the view.
 *
 * Absent when the port never opened, and the engine then falls back to
 * launching a browser of its own — the old behaviour, screencast and all.
 * Degrading is much better than a browser tool that cannot run.
 */
export function embeddedEnv(): Record<string, string> {
  const url = resolveEndpoint();
  if (!url || !viewMark) return {};
  return {
    ONFLIP_EMBEDDED_CDP: url,
    ONFLIP_EMBEDDED_MARK: viewMark,
    // Handed over whole rather than described, because the engine has to
    // navigate back to it when the agent closes the browser — and a URL
    // format agreed between two files in two packages is a format that will
    // drift, at which point the view stops being findable.
    ONFLIP_EMBEDDED_BLANK: blankUrl(),
  };
}

/**
 * The URL a fresh view sits on until something navigates it.
 *
 * It carries the mark, which is how the engine tells this page apart from the
 * app's own UI — also a page, also on the same CDP endpoint, and emphatically
 * not something to hand an agent. Playwright keeps its `Page` handle across
 * navigations, so the mark only has to survive long enough to be found once.
 */
function blankUrl(): string {
  const body = `<title>OnFlip browser ${viewMark}</title>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}

/** Declared before `embeddedEnv` uses it; hoisting keeps the order readable. */
export const blankViewUrl = blankUrl;

/**
 * Chrome's user agent, from Electron's own.
 *
 * Electron advertises itself twice in every request: once as the app
 * ("onflip-desktop/0.8.9") and once as the runtime ("Electron/33.4.11").
 * Both are true and neither belongs on the wire. To a bot check they are the
 * two most conspicuous tokens a request can carry — reported live: Cloudflare
 * challenging page after page, the same verification over and over, on a
 * browser a person was sitting in front of and driving by hand.
 *
 * Everything else already looked like a real browser: `navigator.webdriver`
 * false, five plugins, a real GPU behind WebGL, the `chrome` object present.
 * It was the name badge alone.
 *
 * Derived by removing those two tokens rather than by writing a UA out in
 * full, so the Chrome version stays whatever Chromium is actually underneath.
 * A hard-coded version drifts at the next Electron bump and then claims a
 * Chrome that does not match the engine's own behaviour — which is a worse
 * signal than the one being removed.
 */
export function chromeUserAgent(electronUserAgent: string): string {
  return electronUserAgent
    .replace(/\s*Electron\/\S+/i, "")
    .replace(/\s*onflip[^\s/]*\/\S+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The client-hint header that goes with that user agent.
 *
 * Chromium builds `Sec-CH-UA` from its own brand list, which says "Chromium"
 * and never "Google Chrome", and there is no Electron API to change it. A
 * request whose UA says Chrome while its hints say Chromium-only is exactly
 * the inconsistency these checks look for, so the header is rewritten to
 * agree with the name the UA gives.
 */
function brandHeader(version: string): string {
  return `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not?A_Brand";v="99"`;
}

/** The major Chrome version out of a UA string, or "" when it has none. */
export function chromeMajor(userAgent: string): string {
  return /Chrome\/(\d+)/i.exec(userAgent)?.[1] ?? "";
}

/**
 * Would Chrome send client hints to this URL?
 *
 * Only to a secure origin — which includes localhost, however it is spelled,
 * because Chromium treats loopback as potentially trustworthy.
 */
export function isSecure(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:" || protocol === "wss:") return true;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** What `Sec-CH-UA-Platform` calls the machine this is running on. */
export function platformHint(): string {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  return "Linux";
}

/** The window's view, created on first use. */
export function ensureView(win: BrowserWindow): WebContentsView | null {
  if (!viewMark) return null;
  const existing = views.get(win);
  if (existing && !existing.webContents.isDestroyed()) return existing;

  const view = new WebContentsView({
    webPreferences: {
      // This renders whatever the agent is asked to browse. It gets none of
      // this app: no preload, no Node, and its own session so a page cannot
      // read the cookies the ChatGPT transport signs in with.
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: "persist:onflip-agent-browser",
      webSecurity: true,
    },
  });
  // The agent's browser presents itself as the Chromium it is, without the
  // Electron and app-name tokens Electron adds. Set on the session as well as
  // the page so subresource requests carry it too — a document that claims
  // Chrome while its own scripts and images announce Electron is worse than
  // not bothering.
  const ua = chromeUserAgent(app.userAgentFallback);
  const major = chromeMajor(ua);
  view.webContents.setUserAgent(ua);
  const partition = view.webContents.session;
  partition.setUserAgent(ua);
  if (major) {
    partition.webRequest.onBeforeSendHeaders((details, done) => {
      const headers = details.requestHeaders;
      // Set rather than only replaced. Every Chrome since 89 sends these on
      // a secure origin, so their *absence* is as clear a signal as a wrong
      // value — and Electron was seen sending none at all. Written for
      // secure origins only, because that is also the rule Chrome follows;
      // adding them to a plain-http request would be the anomaly instead.
      if (isSecure(details.url)) {
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase();
          if (lower === "sec-ch-ua" || lower === "sec-ch-ua-mobile" || lower === "sec-ch-ua-platform") {
            delete headers[key];
          }
        }
        headers["sec-ch-ua"] = brandHeader(major);
        headers["sec-ch-ua-mobile"] = "?0";
        headers["sec-ch-ua-platform"] = `"${platformHint()}"`;
      }
      done({ requestHeaders: headers });
    });
  }

  view.setBackgroundColor("#00000000");
  win.contentView.addChildView(view);
  // Parked off-screen rather than absent: a view with no bounds still loads,
  // so the agent can be browsing before the panel has ever been opened.
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  void view.webContents.loadURL(blankUrl());
  views.set(win, view);

  win.once("closed", () => {
    views.delete(win);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  return view;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Put the view where the panel says it is.
 *
 * The renderer owns the layout, so it measures its own placeholder and sends
 * the rectangle. A native view knows nothing about CSS and would otherwise
 * have to be positioned by guessing at the app's own geometry.
 */
export function setViewBounds(win: BrowserWindow, bounds: ViewBounds): boolean {
  const view = ensureView(win);
  if (!view) return false;
  view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  });
  return true;
}

/**
 * Take the view off screen without unloading it.
 *
 * Closing the panel must not throw the page away: the agent may still be
 * working in it, and a half-filled form nobody can see is still a form. Zero
 * bounds hide it and keep it running.
 */
export function hideView(win: BrowserWindow): void {
  const view = views.get(win);
  if (view && !view.webContents.isDestroyed()) {
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

/** What the panel header shows, read from the live view. */
export function viewState(win: BrowserWindow): { url: string; title: string } | null {
  const view = views.get(win);
  if (!view || view.webContents.isDestroyed()) return null;
  const url = view.webContents.getURL();
  // The parked blank page is an implementation detail, not somewhere the
  // user navigated.
  if (url.startsWith("data:") && url.includes(viewMark)) return { url: "", title: "" };
  return { url, title: view.webContents.getTitle() };
}
