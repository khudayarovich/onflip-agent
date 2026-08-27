# OnFlip Desktop

The OnFlip coding agent in a native window — a Codex-style desktop app for Windows.
Same engine as the CLI: it is driven by your **ChatGPT web session**, reads and writes
files, runs shell commands, and verifies its own work behind the same approval layer.

## Architecture

Three processes:

```
┌─────────────┐   IPC    ┌───────────────┐   JSON-RPC / stdio   ┌──────────────────┐
│  renderer    │ ◄──────► │ electron main │ ◄──────────────────► │ engine (Node)     │
│  React + Vite│          │ window + relay │                      │ the OnFlip core   │
└─────────────┘          └───────────────┘                      └──────────────────┘
```

- **`engine/`** runs the core out of the repository's `dist/` under **plain Node**, not
  Electron. That is deliberate: better-sqlite3 ships prebuilt bindings for the Node ABI
  (cookie extraction would break under Electron's), and Playwright behaves exactly as it
  does under the CLI. If no system Node is found the engine falls back to
  `ELECTRON_RUN_AS_NODE`, which works for everything except reading browser cookies —
  and the core already survives that.
- **`electron/`** is a thin shell: it owns the window, spawns the engine, relays
  requests/events, and shows native dialogs (folder picker, save dialog).
- **`ui/`** is the React renderer. Approval prompts, tool cards with live output,
  diffs, todos, sessions, projects, models, settings — all the CLI's features, drawn
  instead of typed.

The protocol between all three lives in `shared/protocol.ts`.

## Develop

```bash
# once, in the repository root: build the core the engine imports
cd .. && npm install && npm run build

# then here
npm install
npm start          # builds engine+main (tsc) and ui (vite), launches Electron
```

`npm run build` builds without launching; `npm run app` launches without rebuilding.

## Installer

```bash
npm run installer     # → release/OnFlip-Setup-<version>.exe (NSIS, x64)
```

`scripts/release.js` compiles everything, temporarily replaces the
`node_modules/onflip` symlink with a real copy of the core (dist plus its
production dependency closure, taken from the root tree so the built
better-sqlite3 binding comes along), runs electron-builder, and restores the
symlink. The app is packaged **unasared** so the engine child can run its
files under plain Node, and `npmRebuild` is off so the native binding keeps
the Node ABI.

The icon pipeline is `npm run icon`: it rasterises `buildResources/logo.svg`
with Playwright and packs `buildResources/icon.ico` (used by the installer,
the exe, and the window). The same SVG is the in-app logo at
`ui/src/assets/logo.svg` — edit one, re-run the script, copy the other.

Sign-in is shared with the CLI: run `onflip login` once in a terminal (after signing in
to chatgpt.com in Chrome, Edge or Firefox) and the desktop app uses the same
`~/.onflip` config, sessions, and logs.

## Notes

- Sessions, approvals, rules, and model config are the same files the CLI uses —
  switching between `onflip` in a terminal and this app keeps everything.
- The window is frameless with a native Windows title-bar overlay; macOS needs a
  different overlay setup and is intentionally not wired up yet.
