/**
 * Turning OnFlip's output into messages that read well in Telegram.
 *
 * Telegram is not a terminal and it is not a browser. It renders a small,
 * strict subset of HTML — bold, italic, code, pre, links, blockquote and
 * nothing else — refuses the whole message if a tag is wrong, and caps a
 * message at 4096 characters. Markdown pasted in raw arrives as literal
 * asterisks and backticks; a stray `<` in a diff arrives as a parse error
 * and the message is simply never delivered.
 *
 * So the assistant's Markdown is translated rather than forwarded, and the
 * pieces that are easy to get wrong — escaping, code fences, splitting a
 * long answer without tearing a code block in half — are pure functions with
 * tests, because a formatting bug here is a message the user never sees.
 */

/** Telegram's own ceiling. Left a little slack for the chunk counter. */
export const TELEGRAM_LIMIT = 4096;
const CHUNK_LIMIT = 3900;

/** The three characters Telegram's HTML parser cares about. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Markdown as Telegram's HTML subset.
 *
 * Code is extracted first and put back last. Everything else is escaped and
 * then has its inline markers converted — doing it the other way round means
 * a `<` inside a code block becomes `&lt;` twice, and an asterisk inside one
 * turns into bold halfway through a shell command.
 */
export function toTelegramHtml(markdown: string): string {
  const blocks: string[] = [];
  let text = markdown;

  // Fenced code first: it is the only construct that can contain anything.
  // The placeholder is wrapped in NULs, written as escapes: no real message
  // contains one, so nothing a user types can be mistaken for a slot.
  text = text.replace(/```([\w+#.-]*)\r?\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    blocks.push(`<pre><code${cls}>${escapeHtml(body.replace(/\n+$/, ""))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  // Then inline code, for the same reason.
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    blocks.push(`<code>${escapeHtml(body)}</code>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  // Links before emphasis: a title can contain underscores.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, href: string) => {
    return `<a href="${href.replace(/"/g, "&quot;")}">${label}</a>`;
  });

  // Headings become a bold line — Telegram has no heading of its own, and a
  // row of hashes reads as noise.
  text = text.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bullets get a real bullet. Numbered lists already read fine.
  text = text.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

  text = text.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/(^|[\s(])\*([^\n*]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  // Underscore italics only between word boundaries, or snake_case names
  // become half-italic.
  text = text.replace(/(^|[\s(])_([^\n_]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");

  // Horizontal rules have no tag; a thin line of characters reads as one.
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "──────────");

  return text.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]);
}

/**
 * Split a formatted message into ones Telegram will accept.
 *
 * Split on line boundaries, and never in the middle of a `<pre>`: half a
 * code block is an unbalanced tag, which Telegram rejects outright — so the
 * block is closed at the break and reopened in the next part.
 */
export function chunkHtml(html: string, limit: number = CHUNK_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const out: string[] = [];
  let current = "";
  let inPre = false;

  const flush = () => {
    if (!current.trim()) {
      current = "";
      return;
    }
    out.push(inPre ? `${current}</code></pre>` : current);
    current = inPre ? "<pre><code>" : "";
  };

  for (const line of html.split("\n")) {
    // A single line longer than the limit has to be cut somewhere; the
    // alternative is a message that can never be sent.
    let rest = line;
    while (rest.length > limit) {
      flush();
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    if (current.length + rest.length + 1 > limit) flush();
    current += (current && !current.endsWith("<pre><code>") ? "\n" : "") + rest;
    // Tracked after appending, so a line that opens a block is inside it.
    if (rest.includes("<pre>")) inPre = true;
    if (rest.includes("</pre>")) inPre = false;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** One line of a message, already escaped. */
export function line(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Cut a single line to length, for the one-line summaries.
 *
 * Telegram collapses newlines in a way that makes a multi-line tool subject
 * look like a broken paragraph, so these are flattened as well as clipped.
 */
export function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// the messages themselves
// ---------------------------------------------------------------------------

export interface StatusLike {
  cwd?: string;
  model?: string;
  thinking?: string;
  approvalMode?: string;
  shellEnabled?: boolean;
  busy?: boolean;
  sessionTitle?: string;
}

/** The folder's own name, without dragging the whole path into a chat. */
export function shortCwd(cwd: string | undefined): string {
  if (!cwd) return "—";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/**
 * The header card: what OnFlip is pointed at right now.
 *
 * Deliberately compact. It is sent on `/status` and after anything that
 * changes it, and a card that took ten lines would push the actual work off
 * a phone screen.
 */
export function statusCard(status: StatusLike): string {
  const rows = [
    `<b>OnFlip</b>${status.busy ? " · <i>working…</i>" : ""}`,
    "",
    `📁 <b>Project</b>  <code>${escapeHtml(shortCwd(status.cwd))}</code>`,
    `🧠 <b>Model</b>  <code>${escapeHtml(status.model ?? "auto")}</code>`,
    `💭 <b>Thinking</b>  <code>${escapeHtml(status.thinking ?? "default")}</code>`,
    `🛡 <b>Access</b>  <code>${escapeHtml(status.approvalMode ?? "ask")}</code>`,
  ];
  if (status.shellEnabled === false) rows.push("⚠️ <i>Shell is off for this session.</i>");
  if (status.sessionTitle) rows.push("", `💬 ${escapeHtml(oneLine(status.sessionTitle, 60))}`);
  return rows.join("\n");
}

/** The icons the activity lines use, by tool. */
const TOOL_ICONS: Record<string, string> = {
  read: "📄",
  write: "✏️",
  edit: "✏️",
  multi_edit: "✏️",
  list: "🗂",
  glob: "🔍",
  grep: "🔍",
  bash: "⚡",
  job_output: "⚡",
  todo_write: "☑️",
  todo_read: "☑️",
  web_fetch: "🌐",
  browser_open: "🌐",
  browser_click: "🖱",
  browser_type: "⌨️",
  browser_screenshot: "📷",
};

/**
 * A tool call, as one line.
 *
 * One line and no result body: a phone showing every command's full output
 * is a phone nobody can read the answer on. The answer is what gets room.
 */
export function toolLine(tool: string, subject: string | undefined, failed: boolean): string {
  const icon = failed ? "❌" : (TOOL_ICONS[tool] ?? "⚙️");
  const name = tool.replace(/_/g, " ");
  const what = subject ? ` <code>${escapeHtml(oneLine(subject, 60))}</code>` : "";
  return `${icon} <i>${escapeHtml(name)}</i>${what}`;
}

/** The final answer, formatted and split. */
export function answerMessages(text: string): string[] {
  return chunkHtml(toTelegramHtml(text.trim()));
}

/** A turn that ended badly. */
export function errorMessage(text: string): string {
  return `⚠️ <b>Stopped</b>\n\n${toTelegramHtml(oneLine(text, 500))}`;
}

/** "Worked for 4m", the way the app shows it. */
export function elapsedLine(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `⏱ ${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `⏱ ${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `⏱ ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The help card, which is also what a stranger sees if they are allowed in. */
export function helpCard(): string {
  return [
    "<b>OnFlip — remote control</b>",
    "",
    "Send any message and it goes to OnFlip as a prompt.",
    "",
    "Ask for a file and it comes back as a file: “send me the report on my "
      + "desktop”, “forward today’s log”. Up to 50 MB.",
    "",
    "<b>Commands</b>",
    "/status — what OnFlip is pointed at",
    "/new — start a fresh chat with no folder",
    "/folder — pick a recent project",
    "/model — choose the model",
    "/thinking — choose the reasoning level",
    "/access — choose what OnFlip may do unattended",
    "/settings — all of the above in one place",
    "/stop — interrupt the running turn",
    "/help — this message",
  ].join("\n");
}
