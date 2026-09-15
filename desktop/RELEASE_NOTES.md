# OnFlip Desktop 0.10.33

**Qwen telling you to sign in to an account you were already signed in to.** Found at last, by measuring the profile instead of trusting it: OnFlip was reading the session from the wrong place.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.33.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.33/OnFlip-Setup-0.10.33.exe) | ~89 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.33-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.33/OnFlip-0.10.33-mac-arm64.dmg) | ~108 MB |
| **macOS** · Intel | [OnFlip-0.10.33-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.33/OnFlip-0.10.33-mac-x64.dmg) | ~115 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and from 0.10.32 the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**"The message went nowhere." "Sign in again." On an account that was signed in.**

Five releases guessed at this. This one measured it. The Qwen profile on the machine it was found on held a session token 209 characters long, correctly formed, with its own expiry twenty-nine days away — and the Qwen page, loaded with that very token, was showing **Log in** and **Sign up**. Side by side with a profile created thirty seconds earlier that had never seen Qwen, the two pages were the same.

The service had quietly dropped the session and left the token sitting there. OnFlip only ever read the token, so it reported itself connected, and every message went into a guest conversation — which Qwen accepts and never answers. That is the whole of it: the ninety-second waits, the "sent nowhere", and being told to sign in to an account the app insisted was fine.

**OnFlip now believes the page rather than the token.** If Qwen is showing you a Log in button, OnFlip says you are signed out, at once, instead of sending into a conversation that cannot reply.

**And the page could not get out of a guest chat once it was in one.** Both `/c/guest` and the sign-in wall live under Qwen's chat address, and the test for "are we already where we belong" was just that — the address. So both became places the browser went and never left. One turn landing in a guest conversation put every turn after it in the same one, each spending its single recovery climbing out of a hole the turn before it had left. The signed-in check read that same stuck page and drew the Sign in button on the strength of it.

## If you are signed out more often than you expect

This release makes OnFlip *honest* about the session; it cannot keep Qwen from ending one. If you find yourself signing in repeatedly, the thing worth ruling out is a second sign-in elsewhere — another machine, or Qwen open in your own browser — since a service that allows one session at a time will end the first when the second begins.

## Honest limits

The check looks for the button Qwen draws for a signed-out visitor. It was measured against a signed-out page and a dead-session page, which draw it identically. There was no live session on the machine to confirm a *signed-in* page does not draw it — the session was already gone, which is how the fault was found at all. If you sign in successfully and OnFlip still says signed out, that is this check being wrong, and it is worth reporting immediately.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.32...desktop-v0.10.33](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.32...desktop-v0.10.33)
