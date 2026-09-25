# OnFlip Desktop 0.10.59

**A ChatGPT sign-in holds, and DeepSeek's thinking is no longer mistaken for an error.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.59.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.59/OnFlip-Setup-0.10.59.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.59-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.59/OnFlip-0.10.59-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.59-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.59/OnFlip-0.10.59-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## Fixed

**ChatGPT**

- **Signing in once is enough.** After signing in through OnFlip's sign-in window, some people were asked to sign in again as soon as they sent a message, or saw "the sent message never appeared". OnFlip was still reading the ChatGPT login from your everyday browser (Firefox, Safari or Chrome) every time it started, and could write that login — sometimes an old one, sometimes another account — over the one you had just made. After a sign-in through the window, OnFlip now uses only its own browser's session and leaves your other browsers alone. **If ChatGPT kept asking you to sign in, sign in once more after updating** — that sign-in is the one OnFlip keeps.
- **"Signed out" only when ChatGPT says so.** OnFlip decided you were signed out from how the page looked, and a page can look signed out for a moment on a session that is fine. It now asks ChatGPT itself first, and if the session is fine it reloads the page instead of asking you to sign in.
- **The sign-in window has the browser to itself.** OnFlip's start-up checks could open its own browser in the middle of a sign-in, on the same profile. They now wait until the sign-in window has closed.
- **The account shown is the account in use.** The account bar could show the account from your everyday browser rather than the one OnFlip was signed in to.

**DeepSeek and Qwen**

- **The AI's thinking is no longer shown as an error.** With Deep Thinking on, DeepSeek writes its reasoning on the page before its answer, and OnFlip read that text looking for DeepSeek's own warnings such as "rate limit". A code review that mentioned "no rate limit" ended the turn with a red "DeepSeek says: …" error made of the AI's own sentence, and paused sending. OnFlip no longer reads the page for warnings while an answer is being written, and only a short standalone line counts as one. Qwen works the same way and gets the same fix.
- **DeepSeek's answer is never stopped by accident.** DeepSeek's send button becomes a Stop button while it answers, and OnFlip could press it to re-send a message whose answer had already started. It now checks first.

**Diagnostics**

- **About → Copy diagnostics now shows what ChatGPT's browser saw.** For ChatGPT it picked the wrong log lines, so it could not show why a message failed or whether the page was signed in. If a ChatGPT problem remains, that paste is what finds it.

Everything from 0.10.58 is included: Free ChatGPT accounts, DeepSeek and Qwen keep to their rate limits, and a pause is no longer the end of the work.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — one, or all three. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.58...desktop-v0.10.59](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.58...desktop-v0.10.59)
