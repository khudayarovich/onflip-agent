# OnFlip Desktop 0.9.1

**The built-in browser no longer announces itself as a robot.** If Cloudflare kept asking you to verify, reloaded, and asked again with no way through — this is that bug. Everything else in [0.9.0](https://github.com/khudayarovich/onflip-agent/releases/tag/desktop-v0.9.0) is unchanged.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.9.1.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.9.1/OnFlip-Setup-0.9.1.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.9.1-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.9.1/OnFlip-0.9.1-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.9.1-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.9.1/OnFlip-0.9.1-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What was wrong

`navigator.webdriver` — the first thing any bot check reads — was **true** in the built-in browser.

Chromium sets that flag whenever a remote debugging port is open. Since 0.8.9 turned the browser panel into a real browser view, that port is always open, because it is how the agent drives the page at all. So the change that made the browser real is the same change that made every site think a machine was holding it. On a page a person had opened and was looking at.

0.9.0 tried to fix the symptom and went after the user agent instead, which was a real signal but the smaller one. Worse, it half-fixed it: `Sec-CH-UA` was rewritten to claim "Google Chrome" while `navigator.userAgentData` — which Electron gives no way to change — went on reporting Chromium. Reading both and comparing them is exactly what a bot check does, so the browser was caught contradicting itself.

## What changed

- **The flag is down.** The obvious lever, `Emulation.setAutomationOverride`, reports success and does nothing — it can raise the flag but not lower one the command line has already set. So the getter is redefined before any page script runs, on `Navigator.prototype` rather than on `navigator`, returning `false` rather than vanishing, so that `"webdriver" in navigator` is still true the way it is in a real Chrome.
- **The hints tell the truth.** `Sec-CH-UA` now says Chromium, matching what page JavaScript reports. A user agent containing `Chrome/130` beside Chromium hints is what every Chromium-derived browser sends; it is the contradiction that stood out, not the name.

Measured on the page from the report, same machine, same build: **through in one navigation and under five seconds** with the flag down, against twenty-five seconds and two navigations with it up.

**Honestly:** in that comparison the old behaviour did eventually get through, after 25 seconds. A site that hands you the click-the-checkbox challenge rather than the silent one may still be harder work — this removes the signal that provokes it, which is not the same as a promise about every site. If you still get stuck, please open an issue with the URL.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

328 automated tests run on every push, including two that keep the client hints from claiming a browser this is not.
