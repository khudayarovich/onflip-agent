/**
 * The document-start script every web-facing window runs.
 *
 * Two things, both closing a gap between "Chromium driven by a debugger" and
 * "the Chrome a person sits in front of", and both invisible until something
 * actively probes for them:
 *
 *   navigator.webdriver — Chromium sets it true whenever a remote debugging
 *   port is open, and the agent's browser needs one. Redefined to false, on
 *   the prototype and configurably, exactly as a real Chrome reads.
 *
 *   window.chrome — a real Chrome exposes `runtime`, `app`, `loadTimes` and
 *   `csi` here. Electron leaves it an empty object, which is one of the
 *   plainest embedded-browser tells there is: measured on the sign-in window,
 *   `Object.keys(window.chrome)` was `[]` while every header, the user agent
 *   and the brand list already looked like Chrome. Google reads this on its
 *   OAuth page and refuses the window as "not secure". The shim gives it the
 *   shape real Chrome has — enums frozen, the two methods that throw for a
 *   page throwing the message they throw in Chrome — without exposing anything
 *   a page could actually call to reach the app: there is no extension id, so
 *   `connect` and `sendMessage` do what they do in a normal tab and refuse.
 *
 * Kept as a plain string so it can be handed straight to
 * `Page.addScriptToEvaluateOnNewDocument`, which runs it before any page
 * script in every document — the only point early enough to matter.
 */
export const BROWSER_SHIM = String.raw`
(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  } catch (e) {}

  try {
    if (window.chrome && window.chrome.runtime) return;
    const c = window.chrome || (window.chrome = {});
    const F = (o) => Object.freeze(o);
    c.app = {
      isInstalled: false,
      InstallState: F({ DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }),
      RunningState: F({ CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }),
      getDetails: function () { return null; },
      getIsInstalled: function () { return false; },
      runningState: function () { return 'cannot_run'; },
    };
    c.runtime = {
      OnInstalledReason: F({ CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }),
      OnRestartRequiredReason: F({ APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }),
      PlatformArch: F({ ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }),
      PlatformNaclArch: F({ ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }),
      PlatformOs: F({ ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }),
      RequestUpdateCheckStatus: F({ NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }),
      connect: function () { throw new TypeError("Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument."); },
      sendMessage: function () { throw new TypeError("Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function callback): chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument."); },
      id: undefined,
    };
    const t0 = performance.timeOrigin / 1000;
    c.loadTimes = function loadTimes() {
      const n = (performance.getEntriesByType('navigation') || [])[0] || {};
      return {
        requestTime: t0,
        startLoadTime: t0,
        commitLoadTime: t0 + (n.responseStart || 0) / 1000,
        finishDocumentLoadTime: t0 + (n.domContentLoadedEventEnd || 0) / 1000,
        finishLoadTime: t0 + (n.loadEventEnd || 0) / 1000,
        firstPaintTime: t0 + 0.1,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      };
    };
    c.csi = function csi() {
      return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 };
    };
  } catch (e) {}
})();
`;
