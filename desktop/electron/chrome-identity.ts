import { app, session, type WebContents } from "electron";
import { Brand, fallbackBrands, renderBrands, withGoogleChrome } from "../shared/chrome-brands";
import { BROWSER_SHIM } from "./browser-shim";

/**
 * Make a window introduce itself as the Chrome it is running.
 *
 * Applied to both windows that face the open web — the agent's browser view
 * and the sign-in window — because they meet the same two checks and were
 * each failing a different one.
 *
 * Everything here goes through the debugger session rather than Electron's
 * own API, for the plain reason that Electron has no API for any of it:
 * `navigator.webdriver` and `navigator.userAgentData` are both read-only from
 * the outside, and the only supported handle on them is the protocol.
 */

/** What a page has to be told, once the real values are known. */
export interface ChromeIdentity {
  userAgent: string;
  brands: Brand[];
  fullVersionList: Brand[];
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  fullVersion: string;
}

/**
 * Ask the page what Chromium actually reports, so the override can keep it.
 *
 * Only the brand lists are changed; the architecture, the platform version
 * and the rest are whatever this machine really is. Writing those out by hand
 * is how a fingerprint starts describing a computer that does not exist —
 * a Windows build claiming a macOS platform version is a far louder signal
 * than the missing brand this is here to add.
 */
async function readIdentity(contents: WebContents): Promise<ChromeIdentity | null> {
  try {
    const raw = (await contents.debugger.sendCommand("Runtime.evaluate", {
      expression:
        "(async () => { const d = navigator.userAgentData; " +
        "const h = d && d.getHighEntropyValues ? await d.getHighEntropyValues(" +
        "['fullVersionList','platformVersion','architecture','bitness','model','uaFullVersion']) : null; " +
        "return JSON.stringify({ ua: navigator.userAgent, brands: d ? d.brands : [], high: h }); })()",
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: string } };
    const value = raw?.result?.value;
    if (!value) return null;
    const parsed = JSON.parse(value) as {
      ua: string;
      brands: Brand[];
      high: {
        fullVersionList?: Brand[];
        platformVersion?: string;
        architecture?: string;
        bitness?: string;
        model?: string;
        uaFullVersion?: string;
      } | null;
    };
    const high = parsed.high ?? {};
    return {
      userAgent: parsed.ua,
      brands: withGoogleChrome(parsed.brands ?? []),
      fullVersionList: withGoogleChrome(high.fullVersionList ?? []),
      platform: navigatorPlatformName(),
      platformVersion: high.platformVersion ?? "",
      architecture: high.architecture ?? "",
      bitness: high.bitness ?? "",
      model: high.model ?? "",
      fullVersion: high.uaFullVersion ?? "",
    };
  } catch {
    return null;
  }
}

function navigatorPlatformName(): string {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  return "Linux";
}

/** The major Chrome version out of a UA string, or "" when it has none. */
export function majorVersion(userAgent: string): string {
  return /Chrome\/(\d+)/i.exec(userAgent)?.[1] ?? "";
}

/**
 * The `Sec-CH-UA` value for a window whose JavaScript reports `brands`.
 *
 * Written from the same list the override installs, which is the whole point:
 * a header composed independently is a header that can disagree, and
 * disagreement is what the bot checks are looking for.
 */
export function headerFor(identity: ChromeIdentity | null, userAgent: string): string {
  const brands = identity?.brands?.length ? identity.brands : fallbackBrands(majorVersion(userAgent));
  return brands.length ? renderBrands(brands) : "";
}

/**
 * Turn off the automation flag and install the brand list.
 *
 * `navigator.webdriver` is true in every window of this app, because Chromium
 * sets it whenever a remote debugging port is open and the agent's browser
 * needs one to be driven at all. `Emulation.setAutomationOverride` looks like
 * the way to lower it and does nothing — measured, it reports success and
 * changes nothing before or after a reload. Redefining the getter before any
 * page script runs does work.
 *
 * Returns the identity that was installed, so the caller can write the
 * matching request header from the same list.
 */
export async function presentAsChrome(contents: WebContents): Promise<ChromeIdentity | null> {
  if (!hideAutomation(contents)) return null;
  return installChromeBrands(contents);
}

/**
 * Attach, and install the document-start shim.
 *
 * Safe to call the moment a window exists: registering a document-start
 * script needs no live page, which is the whole reason it is done this way
 * rather than by evaluating something. See `BROWSER_SHIM` for what it hides —
 * the automation flag and the empty `window.chrome` — and why each matters.
 */
export function hideAutomation(contents: WebContents): boolean {
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  } catch {
    // Another client owns the target; the window still works, unbranded.
    return false;
  }
  void contents.debugger
    .sendCommand("Page.enable")
    .then(() =>
      contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: BROWSER_SHIM,
      })
    )
    .catch(() => {
      /* older protocol, or the target went away */
    });
  return true;
}

/**
 * Install the brand list, once there is a document to read the real one from.
 *
 * Deliberately separate from `hideAutomation`, and deliberately later. This
 * half has to ask the page what Chromium actually reports before it can hand
 * back the same values with one brand added — and at the moment a view is
 * created there is no execution context to ask, so an attempt there returns
 * nothing and silently leaves the JavaScript side unchanged. Measured exactly
 * that way: the header carried Google Chrome from the fallback list while
 * `navigator.userAgentData` still said Chromium, which is the disagreement
 * this whole mechanism exists to avoid.
 */
export async function installChromeBrands(contents: WebContents): Promise<ChromeIdentity | null> {
  if (!contents.debugger.isAttached()) return null;
  const identity = await readIdentity(contents);
  if (!identity || !identity.brands.length) return identity;
  try {
    await contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
      userAgent: identity.userAgent,
      platform: process.platform === "win32" ? "Win32" : undefined,
      userAgentMetadata: {
        brands: identity.brands,
        // Only sent when Chromium gave us one: a full-version list built from
        // major versions alone would contradict the real one it replaces.
        ...(identity.fullVersionList.length ? { fullVersionList: identity.fullVersionList } : {}),
        platform: identity.platform,
        platformVersion: identity.platformVersion,
        architecture: identity.architecture,
        bitness: identity.bitness,
        model: identity.model,
        mobile: false,
        wow64: false,
        ...(identity.fullVersion ? { fullVersion: identity.fullVersion } : {}),
      },
    });
  } catch {
    /* the override is a bonus; the header still carries the brands */
  }
  return identity;
}

/**
 * The partitions that face the open web, and so have to look like a browser.
 *
 * Named rather than inferred, because the app's own renderer must not be
 * touched: attaching a debugger to the UI buys nothing and puts a second
 * client on a target the app already drives.
 */
const WEB_FACING = ["persist:chatgpt-auth", "persist:onflip-agent-browser"];

/**
 * Apply the treatment to every web-facing window, including the ones nobody
 * calls a constructor for.
 *
 * A sign-in with Google does not happen in the window that starts it. The
 * provider opens a popup, `setWindowOpenHandler` allows it, and Electron
 * builds a fresh `WebContents` for it — one that never passed through the
 * code that lowers the automation flag or installs the brand list. So the
 * window Google actually judges was still announcing `webdriver: true` and a
 * Chromium-only brand list, while the parent window beside it looked perfect.
 *
 * That is why fixing the two named windows was not enough, and why this is
 * hooked at the point every `WebContents` passes through rather than at each
 * place one is made. Popups of popups are covered by the same rule, and so is
 * any window a future provider's flow decides to open.
 */
export function guardWebContents(): void {
  app.on("web-contents-created", (_event, contents) => {
    let ours = false;
    for (const name of WEB_FACING) {
      try {
        if (contents.session === session.fromPartition(name)) ours = true;
      } catch {
        /* a partition that does not exist yet is not this one */
      }
    }
    if (!ours) return;
    hideAutomation(contents);
    contents.on("dom-ready", () => {
      void installChromeBrands(contents);
    });
  });
}
