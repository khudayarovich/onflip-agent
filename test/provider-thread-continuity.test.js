"use strict";

/**
 * A DeepSeek or Qwen turn only appends to a conversation the page is on.
 *
 * Both transports send just the new messages while a conversation is live,
 * and decided "live" from an id the driver remembered. The id outlived the
 * browser. Stop closes it five seconds after it is pressed, a crashed
 * renderer is reopened, Qwen reloads a stuck page — and every one of those
 * lands on the chat root, a brand-new chat. The next message then went out
 * as the entire content of that chat: no system prompt, no history, no tool
 * protocol. The model answered like the plain web app, and every turn after
 * it sent only its own new message into that thread.
 *
 * Nothing here launches a browser. Playwright is replaced in the module
 * cache under the exact key the drivers resolve it by, and a launch the test
 * did not arrange throws — so a stub that fails to bind fails the test
 * instead of driving somebody's signed-in account.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-thread-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");

let arranged = null;
const fakePlaywright = {
  chromium: {
    async launchPersistentContext() {
      if (!arranged) throw new Error("a browser launch the test did not arrange");
      const next = arranged;
      arranged = null;
      return next;
    },
  },
};
const playwrightKey = require.resolve("playwright");
require.cache[playwrightKey] = {
  id: playwrightKey,
  filename: playwrightKey,
  loaded: true,
  exports: fakePlaywright,
};

const deepseek = require("../dist/providers/deepseek/browser");
const qwen = require("../dist/providers/qwen/browser");
const { DeepSeekTransport } = require("../dist/providers/deepseek/transport");
const { QwenTransport } = require("../dist/providers/qwen/transport");

test("the stub is what the drivers got", () => {
  assert.equal(require.cache[playwrightKey].exports, fakePlaywright);
});

/** A context with one page, whose URL the test moves by hand. */
function arrange(url) {
  const handlers = {};
  const page = {
    at: url,
    url() {
      return this.at;
    },
    async goto(next) {
      this.at = next;
    },
    async waitForTimeout() {},
    async waitForSelector() {},
  };
  const context = {
    page,
    pages: () => [page],
    newPage: async () => page,
    on: (event, fn) => {
      handlers[event] = fn;
    },
    close: async () => handlers.close?.(),
  };
  arranged = context;
  return context;
}

const DS_CHAT = "https://chat.deepseek.com/a/chat/s/0b1c2d3e-aaaa-4bbb-8ccc-111122223333";
const QW_CHAT = "https://chat.qwen.ai/c/7d1f0c2a-1111-4222-8333-444455556666";

for (const [name, driver, chat, root] of [
  ["DeepSeek", deepseek, DS_CHAT, "https://chat.deepseek.com/"],
  ["Qwen", qwen, QW_CHAT, "https://chat.qwen.ai/"],
]) {
  test(`${name}: closing the browser takes the conversation with it`, async () => {
    arrange(chat);
    await driver.openBrowser();
    driver.noteConversation(chat);
    assert.ok(driver.confirmConversation(), "live while the page is on it");
    await driver.closeBrowser();
    assert.equal(driver.currentConversationId(), null);
    assert.equal(driver.confirmConversation(), null);
  });

  test(`${name}: a browser that closes by itself forgets it too`, async () => {
    const ctx = arrange(chat);
    await driver.openBrowser();
    driver.noteConversation(chat);
    await ctx.close();
    assert.equal(driver.currentConversationId(), null);
  });

  test(`${name}: a page that has left the conversation is not appended to`, async () => {
    const ctx = arrange(chat);
    await driver.openBrowser();
    driver.noteConversation(chat);
    ctx.page.at = root;
    assert.equal(driver.confirmConversation(), null);
    await driver.closeBrowser();
  });
}

/**
 * A transport over the real driver, with only the page work replaced: each
 * send records its body, and the first one "creates" the conversation the
 * way a real answer does.
 */
function transportOver(driver, Transport, chat, patches) {
  const bodies = [];
  const ctx = arrange(chat);
  Object.assign(driver, patches, {
    async sendTurn(body) {
      bodies.push(body);
      ctx.page.at = chat;
      driver.noteConversation(chat);
      return { reply: "ok", ms: 1 };
    },
  });
  return { bodies, ctx, transport: new Transport() };
}

const history = (...turns) => [
  { id: "s", role: "system", content: "SYSTEM PROMPT: the onflip protocol" },
  ...turns.map((content, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content })),
];
const send = (transport, h) => transport.send(h, { model: "m", signal: new AbortController().signal });

for (const [name, driver, Transport, chat, root, patches] of [
  [
    "DeepSeek",
    deepseek,
    DeepSeekTransport,
    DS_CHAT,
    "https://chat.deepseek.com/",
    { setMode: async () => {}, setDeepThink: async () => {}, checkSelectors: async () => ({ ok: true }) },
  ],
  [
    "Qwen",
    qwen,
    QwenTransport,
    QW_CHAT,
    "https://chat.qwen.ai/",
    { setModel: async () => {}, checkSelectors: async () => ({ ok: true }) },
  ],
]) {
  test(`${name}: after the conversation is gone the whole session goes again`, async () => {
    const { bodies, ctx, transport } = transportOver(driver, Transport, chat, patches);
    await driver.openBrowser();

    await send(transport, history("fix the build"));
    assert.match(bodies[0], /SYSTEM PROMPT/, "a new conversation hears everything");

    await send(transport, history("fix the build", "on it", "continue"));
    assert.doesNotMatch(bodies[1], /SYSTEM PROMPT/, "a live one hears only what is new");

    // The page went back to the chat root under the transport's feet.
    ctx.page.at = root;
    await send(transport, history("fix the build", "on it", "continue", "ok", "and again"));
    assert.match(bodies[2], /SYSTEM PROMPT/, "the new chat is told everything, not just the last line");
    assert.match(bodies[2], /fix the build/);

    await driver.closeBrowser();
  });
}

/**
 * Two callers at start — the sign-in check and the first message — used to
 * launch a browser each on one profile (on a Mac the second launch closes
 * the first's), then send one fresh page to the chat twice at once.
 */
for (const [name, driver, root] of [
  ["DeepSeek", deepseek, "https://chat.deepseek.com/"],
  ["Qwen", qwen, "https://chat.qwen.ai/"],
]) {
  test(`${name}: two callers at once share one launch`, async () => {
    const ctx = arrange(root);
    // A second launch would find nothing arranged and throw.
    const [a, b] = await Promise.all([driver.openBrowser(), driver.openBrowser()]);
    assert.equal(a, ctx);
    assert.equal(b, ctx);
    await driver.closeBrowser();
  });

  test(`${name}: two callers at once share one page and one trip to the chat`, async () => {
    const pages = [];
    const trips = [];
    let made = 0;
    const handlers = {};
    const tick = () => new Promise((r) => setImmediate(r));
    arranged = {
      pages: () => pages,
      newPage: async () => {
        made++;
        await tick();
        const page = {
          at: "about:blank",
          url() {
            return this.at;
          },
          async goto(next) {
            trips.push(next);
            await tick();
            this.at = next;
          },
          async waitForTimeout() {},
          async waitForSelector() {},
        };
        pages.push(page);
        return page;
      },
      on: (event, fn) => {
        handlers[event] = fn;
      },
      close: async () => handlers.close?.(),
    };
    const [a, b] = await Promise.all([driver.chatPage(), driver.chatPage()]);
    assert.equal(a, b, "each caller was handed a different page");
    assert.equal(made, 1, "a page was made per caller");
    assert.deepEqual(trips, [root]);
    assert.equal(a.url(), root);
    await driver.closeBrowser();
  });
}
