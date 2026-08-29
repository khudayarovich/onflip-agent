# OnFlip Desktop

The OnFlip app itself: an Electron shell around the agent engine in `../src`.

For what OnFlip is and how to install it, see the [main README](../README.md).
For the reasoning behind the design, see [../docs/architecture.md](../docs/architecture.md)
and [../AGENTS.md](../AGENTS.md).

## Layout

| Path | Role |
| --- | --- |
| `electron/` | Main process: windows, IPC, the sign-in window, the built-in terminal |
| `engine/` | The agent process — one per window — speaking ndjson RPC over stdio |
| `shared/` | The protocol both sides agree on, and the wire codec |
| `ui/` | React renderer (Vite) |
| `buildResources/` | Icons and the logo |
| `scripts/` | Installer build and icon rasterisation |

## Developing

```bash
npm install     # the engine must be built first: npm install in the repo root
npm start       # build everything, then launch
npm run typecheck
```

Environment switches that help while working:

- `ONFLIP_DESKTOP_DEBUG=1` — renderer console to stdout
- `ONFLIP_DESKTOP_SHOT=<path>` — screenshot the window a few seconds after load
- `ONFLIP_BROWSER_HEADLESS=0` — show the browser the agent drives
- `VITE_DEV_SERVER_URL` — load the renderer from Vite instead of `ui-dist/`

The engine writes one log per run to `~/.onflip/logs/`; the shell mirrors the
engine's stderr to `engine-stderr.log` in the app's userData directory.

## Packaging

`npm run installer` produces `release/OnFlip-Setup-<version>.exe`. macOS
artifacts are built by CI — see [../RELEASING.md](../RELEASING.md).
