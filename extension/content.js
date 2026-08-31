/**
 * Runs only on OnFlip's own pairing page, on loopback.
 *
 * Its whole job is to carry the page's one-time token to the part of the
 * extension that is allowed to read cookies. It never touches chatgpt.com, and
 * it cannot: this script is only injected on 127.0.0.1.
 */

const meta = document.querySelector('meta[name="onflip-pairing"]');
const token = meta && meta.getAttribute("content");

if (token) {
  chrome.runtime.sendMessage({ type: "onflip-pair", token, origin: location.origin }, (reply) => {
    const state = document.getElementById("state");
    if (!state) return;
    if (chrome.runtime.lastError) {
      state.textContent = "The extension could not reach OnFlip.";
      return;
    }
    if (reply && reply.ok) return; // the page's own poll says the rest
    state.textContent =
      reply && reply.reason === "no-session"
        ? "This browser is not signed in to ChatGPT. Sign in at chatgpt.com, then reload OnFlip's prompt."
        : "The session could not be handed over.";
  });
}
