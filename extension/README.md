# OnFlip Connector

A small extension that hands your existing ChatGPT session to OnFlip Desktop running on the same computer. It exists because Chrome and Edge encrypt their cookie store with a key bound to the browser itself — deliberately, and OnFlip does not work around it. Asking the browser through the API meant for the job is the honest way in, and it has a side benefit: the browser involved is your real one, with your real profile, already signed in.

## What it does

When OnFlip needs a session it opens your default browser at a page it is serving on `127.0.0.1`. This extension notices that page, reads the cookies for `chatgpt.com`, and posts them straight back to the app on loopback. That is the whole of it.

- It runs on exactly two kinds of page: OnFlip's own pairing page on `127.0.0.1`, and nothing else.
- It reads cookies for `chatgpt.com` and `chat.openai.com` only.
- It sends them to `127.0.0.1` and nowhere else — there is no remote endpoint in the code.
- The app's page carries a one-time token, and the app rejects anything that arrives without it.

Every file here is a few dozen lines and worth reading before you install it.

## Installing

Chrome, Edge, Brave, Opera and every other Chromium browser:

1. Open `chrome://extensions` (`edge://extensions` on Edge).
2. Turn on **Developer mode**, top right.
3. Choose **Load unpacked** and pick this `extension` folder.

That is all — there is no options page and no button to press. The next time OnFlip asks for a session, the handshake completes on its own.

Firefox does not need this. Its cookie store is readable by design, so OnFlip picks a Firefox session up without any help.

## Removing it

Remove it from the extensions page like any other. OnFlip keeps whatever session it already imported; use **Sign out** in the app's account menu to clear that too.
