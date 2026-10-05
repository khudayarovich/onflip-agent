# Workspace interface

The desktop workspace uses graphite surfaces, mint accents, Inter, and a warm
light theme. Shared colors live in `desktop/ui/src/styles.css`; the workspace
layout and component styles live in `desktop/ui/src/workspace.css`. Inter is
bundled locally, with its license included in `ui-dist/licenses/Inter-OFL.txt`.
The flip symbol uses mint and deep green on graphite, alongside the lowercase
wordmark. `desktop/buildResources/logo.svg` is the master artwork. Run
`npm run icon` in `desktop` after editing it; this regenerates the Windows ICO,
macOS PNG, and renderer SVG together. Commit all three generated assets.

The welcome screen shows the signed-in account and real recent projects.
Suggestions fill an editable draft. They do not send a message. Project cards
resume that project's most recent chat, or open its folder if no chat is listed.
Ctrl/Cmd+K opens a searchable action palette; Ctrl/Cmd+F searches the conversation.

Preview, Changes, and Terminal share dock navigation. Changes are the engine's
actual snapshot diffs, paged by line count; Full review opens the searchable
review dialog. The browser and terminal remain mounted when hidden, retaining
the page, running command, and output. Hidden panels are inert and leave the
keyboard tab order. A modal parks the native browser view through the existing
bridge instead of trying to cover it with HTML.

The connection cards show the active service's account, model, and readiness.
Other services are available choices, rather than claimed connected accounts.
Switching still restarts OnFlip and keeps each service's chats separate. Gemini
keeps its API-key setup; ChatGPT, DeepSeek, and Qwen keep their web-session paths.

Motion uses short fades and transitions. Appearance settings persist a motion
toggle, and the system's reduced-motion preference always takes precedence.
Dialogs have accessible names, trap Tab within the top dialog, and restore focus
when closed. The palette respects input-method composition, including key 229.
Approvals take precedence over other dialogs regardless of their DOM order.
They initially focus the dialog container, so a carried-over Enter or Space
cannot activate an approval button before the hotkey guard arms.

## Validation

Run the engine and desktop regression suite from the root with `npm test`.
In `desktop`, run `npm run typecheck`, `npm run build`, and `npm run test:ui`.

The UI check serves the production renderer on an ephemeral loopback port and
injects an isolated bridge fixture. It checks navigation, themes, persistent
drafts, diffs, terminal state, preview bounds and parking, motion preferences,
refused sends, interruption, and compact layout. It writes screenshots and a
result file to a temporary folder, or `ONFLIP_UI_SCREENSHOTS` when supplied.
It requires installed Chrome or Playwright's Chromium. It never opens the real
engine or uses a model account; it checks renderer integration, rather than a
live provider or the native browser's rendering.
