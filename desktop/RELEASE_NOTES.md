# OnFlip Desktop 0.10.69

**Google's Gemini API is the fourth service — bring a free API key, no browser sign-in.**

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File |
| --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.69.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.69/OnFlip-Setup-0.10.69.exe) |
| **macOS** · Apple Silicon | [OnFlip-0.10.69-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.69/OnFlip-0.10.69-mac-arm64.dmg) |
| **macOS** · Intel | [OnFlip-0.10.69-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.69/OnFlip-0.10.69-mac-x64.dmg) |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`. A `SHA256SUMS` file ships alongside, and the updater checks it for you.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## New

- **Gemini API.** Pick it in Settings → Service, then paste a free key from [Google AI Studio](https://aistudio.google.com/api-keys) into the sign-in window or Settings. There is no browser and no sign-in flow behind it: OnFlip talks to Google's API directly, replies stream in as they are written, and the key is stored only on this machine and sent only to Google. The thinking chip drives Gemini's own thinking budget, and Stop, pauses and automatic resume work as they do everywhere else.
- **The model picker is your key's own list.** Google's catalogue moves fast — the 2.5 family was retired for new users the very day this feature was built — so OnFlip reads the list from your key, shows the newest generation first, and checks its chosen default with a free call before trusting it. A model Google retires from under a stored session is stepped off automatically.
- **The key box takes what people actually paste.** A key wearing quotes, an `.env` line, a label, a line-wrap or invisible characters is found inside the paste; whether it *is* a key is then Google's to judge, not a format check's. A paste that is confidently not a key — the "…"-shortened display from the key list, an OAuth client ID, an access token — is named for what it is, without the paste ever being echoed or logged.

## Fixed

- **ChatGPT's sign-in paths refuse on other services.** The browser-session import and the cookie sign-in only ever handle ChatGPT sessions; invoked while another service was running, they could have reported it signed in on a ChatGPT cookie and filed that account's name into the other service's settings. Both now decline and point at the right sign-in.
- **Rate limits are taken as Google states them.** A short stated wait is slept out inside the turn; a long one becomes the ordinary pause, with automatic resume when it passes by itself.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT, DeepSeek or Qwen account — or a free Google AI Studio API key for Gemini. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.68...desktop-v0.10.69](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.68...desktop-v0.10.69)
