/**
 * The half of the connector that is allowed to read cookies.
 *
 * It answers exactly one message, sent by the content script on OnFlip's own
 * pairing page, and it will only ever post to that same loopback origin. Two
 * checks make that true rather than merely intended: the origin has to be one
 * of the ports the app uses, and the cookies are collected by domain rather
 * than by anything the page said.
 */

const ALLOWED_ORIGINS = [
  "http://127.0.0.1:43117",
  "http://127.0.0.1:43118",
  "http://127.0.0.1:43119",
  "http://127.0.0.1:43120",
  "http://127.0.0.1:43121",
];

/** Where a ChatGPT session actually lives, current domain and the old one. */
const DOMAINS = ["chatgpt.com", "chat.openai.com"];

async function collectCookies() {
  const seen = new Map();
  for (const domain of DOMAINS) {
    const found = await chrome.cookies.getAll({ domain });
    for (const cookie of found) {
      // Later domains must not overwrite a cookie the current one supplied:
      // chat.openai.com still holds stale copies on long-lived profiles.
      if (!seen.has(cookie.name)) seen.set(cookie.name, cookie.value);
    }
  }
  return [...seen].map(([name, value]) => ({ name, value }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "onflip-pair") return false;

  const origin = message.origin;
  if (!ALLOWED_ORIGINS.includes(origin)) {
    sendResponse({ ok: false, reason: "bad-origin" });
    return false;
  }
  // The sender has to be the page we think it is, not another extension page
  // that happened to guess the message shape.
  if (!sender.url || sender.url.indexOf(origin + "/pair") !== 0) {
    sendResponse({ ok: false, reason: "bad-origin" });
    return false;
  }

  (async () => {
    try {
      const cookies = await collectCookies();
      if (!cookies.some((c) => /session-token/i.test(c.name))) {
        sendResponse({ ok: false, reason: "no-session" });
        return;
      }
      const response = await fetch(origin + "/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OnFlip-Pairing": message.token,
        },
        body: JSON.stringify({ cookies }),
      });
      const result = await response.json();
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, reason: String(e) });
    }
  })();

  return true; // the response is asynchronous
});
