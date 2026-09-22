import { app, BrowserWindow, WebContentsView } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import {
  hideAutomation,
  installChromeBrands,
  headerFor,
  type ChromeIdentity,
} from "./chrome-identity";
import { fallbackBrands, renderBrands } from "../shared/chrome-brands";
import { isWebUrl } from "../shared/open-safety";

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
 *
 * What that port is, stated exactly, because an external audit raised it and
 * a vague answer would be worse than none:
 *
 * It is the DevTools protocol for this whole Chromium — every view in it,
 * including OnFlip's own interface. Anything that can reach it can drive the
 * browser, read what is on a page and run script in it. There is no
 * authentication; Chromium does not offer any. The DNS-rebinding case is
 * already covered — Chromium validates the Host header, so a web page cannot
 * reach it — and the port is ephemeral, so it is not a number to guess at
 * once and reuse. What remains is a *local* process reaching loopback.
 *
 * Against a process running as this user that is not a meaningful step up:
 * it can already read the browser profiles, the session tokens and the
 * config directly. Against another account on a shared machine it is, and
 * file permissions do not close it, because a port can be found by scanning
 * where a 0700 directory cannot be read.
 *
 * The port cannot be secured while it exists, because the feature *is* the
 * port: the agent's browser tool drives the docked view over it. So the
 * honest control is whether it opens at all, and it is a setting rather than
 * an environment variable — a defence nobody can find is not a defence.
 * Left on by default, because turning it off silently would remove a working
 * feature from everyone to protect the few on a shared machine.
 */
export function enableEmbeddedBrowser(): void {
  if (process.env.ONFLIP_EMBEDDED_BROWSER === "0") return;
  if (embeddedBrowserDisabled()) {
    console.log("[browser] the embedded browser is off in Settings; no DevTools port will be opened");
    return;
  }
  viewMark = randomBytes(9).toString("hex");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.ONFLIP_CDP_PORT ?? "0");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

/**
 * Read the setting straight off disk.
 *
 * This runs before `app.whenReady()` — the switch is ignored after Chromium
 * has started — which is before anything else in the app is up, so there is
 * nothing to ask but the file. Any failure leaves the feature on: a
 * misparsed config should not quietly remove the Browser pane.
 */
function embeddedBrowserDisabled(): boolean {
  try {
    const file = path.join(os.homedir(), ".onflip", "config.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as {
      embeddedBrowser?: unknown;
    };
    return raw.embeddedBrowser === false;
  } catch {
    return false;
  }
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
export function embeddedEnv(win: BrowserWindow): Record<string, string> {
  const url = resolveEndpoint();
  if (!url || !viewMark) return {};
  const mark = markFor(win);
  return {
    ONFLIP_EMBEDDED_CDP: url,
    ONFLIP_EMBEDDED_MARK: mark,
    // Handed over whole rather than described, because the engine has to
    // navigate back to it when the agent closes the browser — and a URL
    // format agreed between two files in two packages is a format that will
    // drift, at which point the view stops being findable.
    ONFLIP_EMBEDDED_BLANK: blankUrl(mark),
  };
}

const windowMarks = new WeakMap<BrowserWindow, string>();

/**
 * The mark of one window's view.
 *
 * It was one mark for the whole app, so every window's idle view sat on the
 * same URL and an engine attached to the first page carrying it: with two
 * windows open, window B's agent could browse in window A's panel while its
 * own stayed blank, and two engines could share one page. Each window's view
 * now has its own. The app-wide mark stays its prefix, which is what tells
 * any of them apart from the app's own pages, and the suffix is random and
 * of one length, so no window's mark is ever a substring of another's.
 */
export function markFor(win: BrowserWindow): string {
  let mark = windowMarks.get(win);
  if (!mark) {
    mark = `${viewMark}-${randomBytes(6).toString("hex")}`;
    windowMarks.set(win, mark);
  }
  return mark;
}

/**
 * The URL a fresh view sits on until something navigates it.
 *
 * It carries the mark, which is how the engine tells this page apart from the
 * app's own UI — also a page, also on the same CDP endpoint, and emphatically
 * not something to hand an agent. Playwright keeps its `Page` handle across
 * navigations, so the mark only has to survive long enough to be found once.
 */
export function blankUrl(mark: string): string {
  const body = `<title>OnFlip browser ${mark}</title>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}

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
 * Electron sends no `Sec-CH-UA` at all, and on a secure origin every Chrome
 * since 89 sends one — an absence is as clear a signal as a wrong value, so
 * the header is supplied.
 *
 * It names Google Chrome. Two earlier versions of this got it wrong in
 * opposite directions, and both were half-right. Claiming Chrome here while
 * `navigator.userAgentData` still said Chromium was the contradiction
 * Cloudflare looks for. Saying Chromium in both was consistent, and Google
 * refused it — the "browser or app may not be secure" page that ends a
 * sign-in with Google. Neither could be fixed alone, because the header and
 * the JavaScript were being set by different mechanisms.
 *
 * `presentAsChrome` sets both from one list, so the two agree *and* say
 * Chrome. This is the fallback wording for when the override could not read
 * Chromium's real brands; normally the header is written from the very list
 * the page reports.
 */
export function brandHeader(version: string): string {
  return renderBrands(fallbackBrands(version));
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
  // Filled in once the view reports what Chromium really claims; until then
  // the header falls back to the versions in the user agent.
  let identity: ChromeIdentity | null = null;
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
        headers["sec-ch-ua"] = headerFor(identity, ua);
        headers["sec-ch-ua-mobile"] = "?0";
        headers["sec-ch-ua-platform"] = `"${platformHint()}"`;
      }
      done({ requestHeaders: headers });
    });
  }

  // Before anything is loaded, so the first real page already has it. Once
  // only: the script is registered against the target and runs for every
  // document after it, and re-registering per navigation would stack copies.
  hideAutomation(view.webContents);
  // The brand list needs a live document to read the real one from, so it
  // waits for the first one — and re-reads after a cross-origin navigation,
  // which swaps the execution context out from under the override.
  const brandOnce = () => {
    void installChromeBrands(view.webContents).then((installed) => {
      if (installed) identity = installed;
    });
  };
  view.webContents.on("dom-ready", brandOnce);

  // A page the agent visits may open windows of its own, and Electron has no
  // popup blocker: each one became a native window that outlived the panel.
  // A web address opens in the view itself, the way a tab would follow a
  // link; anything else is refused.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void view.webContents.loadURL(url);
    return { action: "deny" };
  });

  view.setBackgroundColor("#00000000");
  win.contentView.addChildView(view);
  // Parked off-screen rather than absent: a view with no bounds still loads,
  // so the agent can be browsing before the panel has ever been opened.
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  void view.webContents.loadURL(blankUrl(markFor(win)));
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
  // Placing it is also what brings it back after a modal has had the screen.
  view.setVisible?.(true);
  return true;
}

/**
 * Take the view off screen without unloading it.
 *
 * Closing the panel must not throw the page away: the agent may still be
 * working in it, and a half-filled form nobody can see is still a form.
 *
 * `setVisible(false)` is what actually takes it out of the picture, and zero
 * bounds are kept beside it rather than instead of it. A native view is
 * composited above the window's own web contents, so nothing drawn in HTML
 * can cover it and no `z-index` applies — which is why a modal opened behind
 * the browser. Bounds alone were not enough to rely on: a zero-area view
 * paints nothing, but the page behind it keeps its old layout and the view
 * stays in the window's stack, so the state was neither reliably hidden nor
 * observably so. Visibility is the property that answers the question being
 * asked, and the page reports it — `document.visibilityState` goes to
 * `hidden`, which is how this is tested.
 *
 * Optional-called because the method arrived in a later Electron than the
 * one this shipped on first; without it the zero bounds still apply.
 */
export function hideView(win: BrowserWindow): void {
  const view = views.get(win);
  if (view && !view.webContents.isDestroyed()) {
    view.setVisible?.(false);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

/**
 * What the toolbar can do to the view.
 *
 * A panel with no address bar and no back button is a browser you can only
 * watch. These are the four things a person reaches for without thinking,
 * and they are the view's own — the agent's Playwright handle is unaffected
 * by any of them, because it holds the page, not the URL.
 */
export type ViewAction = "back" | "forward" | "reload" | "stop";

export function actOnView(win: BrowserWindow, action: ViewAction): boolean {
  const view = views.get(win);
  if (!view || view.webContents.isDestroyed()) return false;
  const wc = view.webContents;
  const nav = (wc as unknown as { navigationHistory?: { goBack(): void; goForward(): void; canGoBack(): boolean; canGoForward(): boolean } }).navigationHistory;
  switch (action) {
    // Electron 36 moved these onto `navigationHistory` and deprecated the
    // old spelling; both are accepted so this keeps working either side of
    // that change rather than silently doing nothing after an upgrade.
    case "back":
      if (nav?.canGoBack()) nav.goBack();
      else if (wc.canGoBack?.()) wc.goBack();
      return true;
    case "forward":
      if (nav?.canGoForward()) nav.goForward();
      else if (wc.canGoForward?.()) wc.goForward();
      return true;
    case "reload":
      wc.reload();
      return true;
    case "stop":
      wc.stop();
      return true;
  }
}

/**
 * Send the view somewhere, forgivingly.
 *
 * People type "example.com", not "https://example.com", and they paste
 * things with spaces around them. Anything that is not a URL at all becomes
 * a search rather than an error page, which is what every browser does and
 * what makes an address bar usable as one.
 */
export function navigateView(win: BrowserWindow, input: string): boolean {
  const view = ensureView(win);
  if (!view) return false;
  view.webContents.loadURL(normaliseUrl(input));
  return true;
}

export function normaliseUrl(input: string): string {
  const text = input.trim();
  if (!text) return "about:blank";
  // A scheme, but only a real one. "localhost:3000" also matches "a word
  // followed by a colon", and treating that as a scheme leaves it untouched
  // — so the commonest address anybody types into this bar went nowhere.
  //
  // The list used to include `file:`, `data:`, `blob:`, `view-source:`,
  // `chrome:` and `devtools:`. An external audit flagged the breadth, and it
  // is hard to argue with: this is the bar a person types an address into,
  // and none of those six is an address a person types. What they are is the
  // interesting half of a browser's attack surface — `devtools:` most of all
  // — reachable by anything that can put a string in front of somebody,
  // including a page telling them to paste one.
  //
  // So the bar navigates the web, and nothing else. Anything unrecognised
  // falls through to the search below rather than being loaded, which is
  // what a browser does with a word it cannot parse.
  if (/^https?:/i.test(text)) return text;
  if (text.toLowerCase() === "about:blank") return "about:blank";
  if (/^https?:\/\//i.test(text)) return text;

  // Loopback and bare IPv4 first, and over http. An address like
  // "127.0.0.1:5173" is word characters separated by dots, so a
  // general "looks like a host" rule matches it and sends a local dev
  // server to https — which it is not serving, so the page fails to load.
  // Caught exactly that way: typing 127.0.0.1:55377 opened
  // https://127.0.0.1:55377 and got an error page.
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`;

  // A hostname with a dot in it, or one with a port: "example.com",
  // "docs.example.com/x", "myhost:8080".
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|.*)?$/.test(text) && !text.includes(" ")) {
    return `https://${text}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/** Everything the toolbar needs to draw itself. */
export interface ViewChrome {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * The page is a provider refusing this window for a sign-in.
   *
   * Only Google does this today, and it is not something the panel can be
   * fixed into passing: Google blocks OAuth in embedded browsers on purpose,
   * as their enforcement of RFC 8252, and maintains the check against exactly
   * the kind of work that would defeat it. Four separate fingerprint fixes
   * here — the user agent, the brand list, `navigator.webdriver`, an empty
   * `window.chrome` — each corrected a real tell and none of them changed the
   * answer, because the refusal is decided server-side at the consent step.
   *
   * So the panel stops pretending it might work and offers the way that does.
   */
  signInBlocked?: boolean;
}

/**
 * Is this page a provider turning the embedded window away from a sign-in?
 *
 * Matches the page Google lands on, not the attempt: the flow reaches
 * `/signin/rejected` and stops there, which is the moment there is something
 * useful to say.
 */
export function isSignInRefusal(url: string): boolean {
  return /accounts\.google\.com\/.*(signin\/rejected|disallowed_?useragent|deniedsigninrejected)/i.test(
    url
  );
}

/**
 * Where "open in my browser" should actually go from a refusal page.
 *
 * Not the page itself. Google's refusal URL is a one-time thing full of
 * request-bound tokens — `dsh`, `rart`, `epd`, a `continue` pointing at a
 * consent step that has already been declined — and handing it to a fresh
 * browser gets a bare "400. Произошла ошибка." Reported immediately, because
 * that is exactly what the button did on its first use.
 *
 * What the user wants is the site they were signing in to, which Google
 * helpfully names in `app_domain`. Landing there in a real browser puts them
 * one click from the sign-in that will work. Falls back to the page's own
 * origin, and then to nothing rather than to a URL known to fail.
 */
export function externalTarget(url: string): string {
  if (!/^https?:\/\//i.test(url)) return "";
  if (!isSignInRefusal(url)) return url;
  try {
    const parsed = new URL(url);
    const app = parsed.searchParams.get("app_domain");
    if (app && /^https?:\/\//i.test(app)) return app;
    return parsed.origin;
  } catch {
    return "";
  }
}

export function viewChrome(win: BrowserWindow): ViewChrome | null {
  const view = views.get(win);
  if (!view || view.webContents.isDestroyed()) return null;
  const wc = view.webContents;
  const nav = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean } }).navigationHistory;
  const url = wc.getURL();
  const blank = url.startsWith("data:") && url.includes(viewMark);
  return {
    url: blank ? "" : url,
    title: blank ? "" : wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: nav ? nav.canGoBack() : Boolean(wc.canGoBack?.()),
    canGoForward: nav ? nav.canGoForward() : Boolean(wc.canGoForward?.()),
    signInBlocked: isSignInRefusal(url) || undefined,
  };
}

/** Tell the window whenever the toolbar's state could have changed. */
export function watchViewChrome(win: BrowserWindow, notify: () => void): void {
  const view = ensureView(win);
  if (!view) return;
  const wc = view.webContents;
  // Listed one by one rather than looped: each of these events has its own
  // handler signature, and a union of names does not resolve against them.
  wc.on("did-start-loading", () => notify());
  wc.on("did-stop-loading", () => notify());
  wc.on("did-navigate", () => notify());
  wc.on("did-navigate-in-page", () => notify());
  wc.on("page-title-updated", () => notify());
  wc.on("did-fail-load", () => notify());
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
