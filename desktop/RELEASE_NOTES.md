# OnFlip Desktop 0.10.5

**Fewer requests, less ceremony, and a step budget that knows the difference between thrash and work.** Turns are typed into the composer on every plan instead of being uploaded as files — the pattern behind accounts getting rate-limited mid-task — small follow-up changes skip the task-list ritual, and a turn stopped at the step budget mid-stride now earns one bounded extension instead of stopping cold.

<img src="https://raw.githubusercontent.com/khudayarovich/onflip-agent/main/.github/assets/screenshot.png" width="820" alt="OnFlip">

## Download

| Platform | File | Size |
| --- | --- | --- |
| **Windows** 10/11 | [OnFlip-Setup-0.10.5.exe](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.5/OnFlip-Setup-0.10.5.exe) | ~84 MB |
| **macOS** · Apple Silicon | [OnFlip-0.10.5-mac-arm64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.5/OnFlip-0.10.5-mac-arm64.dmg) | ~101 MB |
| **macOS** · Intel | [OnFlip-0.10.5-mac-x64.dmg](https://github.com/khudayarovich/onflip-agent/releases/download/desktop-v0.10.5/OnFlip-0.10.5-mac-x64.dmg) | ~108 MB |

The `.zip` and `.blockmap` files below are for the in-app updater — you want the `.exe` or the `.dmg`.

**On 0.8.7 or later?** You should not need this page: the app offers the update itself.

## What's new

**Turns are typed, not uploaded — on every plan.** Large turns used to go to ChatGPT as an attached file, and once a session grew past the threshold, practically every send carried one. Each of those uploads is an extra backend request, and a Pro account in the field was throttled outright (HTTP 429, locked for minutes) by exactly that pattern. Every plan now types every turn into the composer; sessions compact a little more often in exchange for far fewer requests. If you preferred the old trade, `ONFLIP_UPLOAD_ABOVE=45000` in the environment brings it back.

**Small changes stay small.** Asking for a quick tweak after a finished task used to trigger the full ritual — a written plan, item-by-item updates, a complete build to verify — minutes of ceremony around a one-line change. The agent now skips the task list for follow-up tweaks and one-file fixes, and verifies at the scale of the change: the affected test, not the whole suite.

**The step budget stops thrash, not work.** When a turn hits the step limit while its last steps were all landing — real work, just a big job — it now continues for up to 20 more steps, once, and says so. A turn that was spinning (refusals, repeated failures) still stops exactly where it always did: every step is a real request on your account, and the budget exists to protect it. When the extension was used, the stop banner says so rather than showing "60 of 40".

Everything here works the same on ChatGPT and DeepSeek.

## Requirements

Windows 10/11, or macOS 12+ on Apple Silicon or Intel. A ChatGPT account, a DeepSeek account, or both. No API key. The Telegram features need a bot token in Settings → Telegram.

**Full changelog:** [desktop-v0.10.4...desktop-v0.10.5](https://github.com/khudayarovich/onflip-agent/compare/desktop-v0.10.4...desktop-v0.10.5)
