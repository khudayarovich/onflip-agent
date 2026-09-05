# OnFlip Desktop 0.8.9

**The browser is a real browser now.** Not a sharper picture of one — an actual browser view inside the window, with working hover, native scrolling and text that stays crisp. And on some machines it was not working at all; that is fixed too.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.8.9.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.9/OnFlip-Setup-0.8.9.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.8.9-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.9/OnFlip-0.8.9-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.8.9-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.8.9/OnFlip-0.8.9-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or 0.8.8?** You should not need this page: the app offers the update itself.

## A real browser, not a video of one

The panel used to show a *screencast* of a separate Chromium — an image swapped several times a second, with your clicks played back into the real page as coordinates. It worked, and it always looked like what it was. Text was soft, scrolling stuttered, and hovering did nothing at all, because there is no such thing as hovering a screenshot. A cookie banner or a login field was something to watch rather than something to use.

It is now a browser view docked straight into the window, composited the way any browser tab is:

- **Hover works.** Links highlight, menus drop down, tooltips appear.
- **Text is sharp** at any screen density, and scrolling is smooth.
- **Selection works** — you can drag over text on the page and copy it.
- **Nothing to download.** The agent's browser is the app's own, so there is no second Chromium to fetch, and it starts instantly.

The agent drives it exactly as before, so every browsing task behaves the same — it just looks and feels like a browser now.

## Fixed

- **The agent's browser could fail to start at all.** On a machine with no Chrome, every `browser_open` failed with `Executable doesn't exist at …chrome-headless-shell.exe`, and OnFlip then advised running `npx playwright install` — which could not have helped. A hidden browser runs from a second download that OnFlip never fetched, and the check that was supposed to notice only looked for the first one. Seen on a real session: three attempts, three identical failures, a wasted turn, and no browser.
- **Long sessions could still answer in the wrong language.** 0.8.8 carried your request through the point where a long conversation gets summarised, which was right but not enough — after that the model sees its own previous replies, all in the drifted language, and matches those. OnFlip now quotes your own words back to it on every turn.
- **Edits could fail three at a time after a long session.** When a conversation is summarised the file contents go with it, and the agent would then edit from memory: `old_string not found`, three times in one reply, then a round trip to re-read what it had just lost. The summary now says plainly that the files must be read again.

## Also in this release

The **Working** label changes as a turn runs long — "Still working" after a minute, "Taking longer than usual" after five — and its glow turns orange. The animation is the same; only the colour changes, so it reads as the same indicator rather than as an alarm. While a reply is actually streaming it still says so, because that is the honest answer even on a long turn.

## Requirements

Windows 10/11, or macOS 13+. A ChatGPT account — the free plan is enough.

## Installing

**Windows:** the build is unsigned, so SmartScreen warns — **More info → Run anyway**.
**macOS:** the app is ad-hoc signed, not notarised, so the first launch needs **right-click → Open → Open**.

## Under the hood

Embedding a real browser means the app opens a debugging port for itself. It listens only on this machine, on a different port every run, and it is what lets the agent drive the view. If it cannot be opened, the old screencast takes over automatically; `ONFLIP_EMBEDDED_BROWSER=0` forces that too.

207 automated tests run on every push, up from 202.
