import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { shell } from "electron";

/**
 * Signing in through the browser the user already uses.
 *
 * Reading cookies out of Chrome stopped being possible: since Chrome 127 the
 * cookie file is encrypted with a key bound to Chrome itself, and the ways
 * around that are the ways malware gets in. Driving Chrome over its debugging
 * port is refused on a real profile, and launching it with automation flags is
 * exactly the fingerprint Cloudflare turns away.
 *
 * What is left is to ask the browser instead of taking from it. A small
 * extension in the user's own Chrome can read chatgpt.com cookies through the
 * API meant for that, and hand them to OnFlip over a loopback socket. Nothing
 * is decrypted, no flags are set, and the browser is the ordinary one with the
 * ordinary profile — which is also the browser the user wanted to see.
 *
 * The handshake, in order:
 *
 *  1. OnFlip opens a server on 127.0.0.1 and asks the system to open the
 *     default browser at it — the real browser, with its real profile.
 *  2. That page carries a one-time token. Only a page served from this server
 *     has it, and only an extension holding permission for this origin can
 *     read it, so no other site can talk to the socket.
 *  3. The extension reads the token, collects the cookies, and posts them back
 *     with the token in a header.
 *  4. The server checks the token, hands the cookies to the app, and stops
 *     listening. It exists for three minutes at most.
 */

export interface PairResult {
  ok: boolean;
  cookies?: { name: string; value: string }[];
  reason?: string;
}

/**
 * Fixed ports, because an extension has to declare in advance which origins it
 * may talk to and a random port cannot be declared. A short list rather than
 * one, so a second window — or anything else already on 43117 — does not break
 * the flow.
 */
export const PAIRING_PORTS = [43117, 43118, 43119, 43120, 43121];

/** Long enough to install the extension mid-flow, short enough to be safe. */
const WINDOW_MS = 3 * 60_000;

function page(token: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="onflip-pairing" content="' + token + '">',
    "<title>Connect OnFlip</title>",
    "<style>",
    "  :root { color-scheme: light dark; }",
    "  body { margin:0; min-height:100vh; display:grid; place-items:center;",
    '    font:15px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;',
    "    background:#0e0e10; color:#f2f2f3; }",
    "  @media (prefers-color-scheme: light) { body { background:#fbfbfc; color:#16161a; } }",
    "  main { max-width:30rem; padding:2.5rem 2rem; text-align:center; }",
    "  h1 { font-size:1.35rem; font-weight:600; margin:0 0 .75rem; }",
    "  p { margin:0 0 1rem; opacity:.78; }",
    "  .state { margin-top:1.75rem; font-weight:500; opacity:.6; }",
    "  .ok { color:#3fb950; opacity:1; }",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Connect OnFlip</h1>",
    "<p>OnFlip is asking this browser for the ChatGPT session you are already",
    "signed in to. Nothing leaves this computer.</p>",
    "<p>If nothing happens, the OnFlip extension is not installed in this",
    "browser yet — the app shows you where to find it.</p>",
    '<div class="state" id="state">Waiting for the extension…</div>',
    "</main>",
    "<script>",
    'var state = document.getElementById("state");',
    "var tick = setInterval(function () {",
    '  fetch("/status", { cache: "no-store" })',
    "    .then(function (r) { return r.json(); })",
    "    .then(function (j) {",
    "      if (!j.done) return;",
    "      clearInterval(tick);",
    '      state.textContent = "Signed in. You can close this tab.";',
    '      state.className = "state ok";',
    "    })",
    "    .catch(function () { /* the server closes once it is finished */ });",
    "}, 700);",
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Open the browser and wait for it to answer.
 *
 * Resolves either with the cookies the extension sent or with a reason the
 * user can act on. It never rejects: this is a sign-in path, and an exception
 * here would reach the user as a stack trace in a modal.
 */
export function pairWithBrowser(): Promise<PairResult> {
  return new Promise<PairResult>((resolve) => {
    const token = randomBytes(24).toString("hex");
    let settled = false;
    let done = false;

    const finish = (result: PairResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(result);
    };

    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0];

      // Permissive headers are safe here because the token is what actually
      // authorises, and only a page this server served carries one.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-onflip-pairing");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      if (req.method === "GET" && (url === "/pair" || url === "/")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(token));
        return;
      }

      if (req.method === "GET" && url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ done }));
        return;
      }

      if (req.method === "POST" && url === "/session") {
        if (req.headers["x-onflip-pairing"] !== token) {
          res.writeHead(403).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // A session jar is a few kilobytes. Anything larger is not one.
          if (size > 256 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              cookies?: { name?: string; value?: string }[];
            };
            const cookies = (body.cookies ?? [])
              .filter(
                (c): c is { name: string; value: string } =>
                  typeof c?.name === "string" && typeof c?.value === "string"
              )
              .map((c) => ({ name: c.name, value: c.value }));

            if (!cookies.some((c) => /session-token/i.test(c.name))) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, reason: "no-session" }));
              finish({
                ok: false,
                reason:
                  "That browser is not signed in to ChatGPT. Open chatgpt.com there, sign in, and try again.",
              });
              return;
            }

            done = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            // A moment for the page to notice before the socket goes away.
            setTimeout(() => finish({ ok: true, cookies }), 1_200);
          } catch {
            res.writeHead(400).end();
          }
        });
        return;
      }

      res.writeHead(404).end();
    });

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          reason: "The browser did not answer. Install the OnFlip extension in it, then try again.",
        }),
      WINDOW_MS
    );

    const listen = (index: number): void => {
      const port = PAIRING_PORTS[index];
      if (port === undefined) {
        finish({ ok: false, reason: "No local port was free for the handshake." });
        return;
      }
      server.once("error", () => listen(index + 1));
      server.listen(port, "127.0.0.1", () => {
        void shell.openExternal("http://127.0.0.1:" + port + "/pair");
      });
    };
    listen(0);
  });
}
