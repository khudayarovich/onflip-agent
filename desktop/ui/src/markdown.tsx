import React from "react";
import { CopyButton } from "./components/CopyButton";

/**
 * A small Markdown renderer that produces React elements directly.
 *
 * Deliberately hand-rolled rather than innerHTML from a library: model output
 * is untrusted, and building nodes through React means nothing is ever parsed
 * as HTML — there is no sanitisation step because there is no HTML step.
 * Covers what agent replies actually use: fenced code, headings, lists,
 * blockquotes, tables are left as text, plus inline code/bold/italic/links.
 */

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

/**
 * The inline grammar.
 *
 * Underscores emphasise only at word boundaries: `my_var_name` and
 * `C:\Users\john_doe\my_project` are names, not italics, and `__init__` is a
 * method, not bold "init" — so `__bold__` is not supported at all; models
 * write `**bold**`. A URL may hold balanced parentheses (Wikipedia's
 * `Foo_(bar)`), which used to end the link at "(bar".
 */
const INLINE_RE =
  /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|(?<![\w\\])_([^_\s][^_]*)_(?!\w)|\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|(https?:\/\/(?:[^\s<>"'()[\]]|\([^\s<>"'()]*\))+)/g;

export function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (match[2] !== undefined) {
      out.push(<code key={key++}>{match[2]}</code>);
    } else if (match[3] !== undefined) {
      out.push(<strong key={key++}>{renderInline(match[3])}</strong>);
    } else if (match[4] !== undefined || match[5] !== undefined) {
      out.push(<em key={key++}>{renderInline(match[4] ?? match[5]!)}</em>);
    } else if (match[6] !== undefined && match[7] !== undefined) {
      out.push(
        <a key={key++} href={match[7]} target="_blank" rel="noreferrer">
          {match[6]}
        </a>
      );
    } else if (match[8] !== undefined) {
      // A bare address usually ends a clause: "see https://x.y/docs." The
      // punctuation is the sentence's, not the link's, so it goes back to
      // being text rather than into a 404.
      const url = match[8].replace(/[.,;:!?]+$/, "");
      out.push(
        <a key={key++} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
      );
      if (url.length < match[8].length) out.push(match[8].slice(url.length));
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

interface ListItem {
  marker: "ul" | "ol";
  text: string;
  /** The number an ordered item was written with. */
  number?: number;
}

/**
 * Memoised on `text`: every streaming delta re-renders the whole transcript,
 * and without this each finished assistant reply was re-tokenised from
 * scratch for every character that arrived in the newest one.
 */
export const Markdown = React.memo(function Markdown({
  text,
}: {
  text: string;
}): React.ReactElement {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let key = 0;

  let paragraph: string[] = [];
  let list: ListItem[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={key++}>{renderInline(paragraph.join("\n"))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const kind = list[0].marker;
    const items = list.map((item, i) => <li key={i}>{renderInline(item.text)}</li>);
    // Numbered from the number written: steps separated by blank lines or
    // by a code block each flush a list of their own, and every one of
    // them used to start again at 1.
    const start = list[0].number;
    blocks.push(
      kind === "ul" ? (
        <ul key={key++}>{items}</ul>
      ) : (
        <ol key={key++} start={start !== undefined && start !== 1 ? start : undefined}>
          {items}
        </ol>
      )
    );
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(<blockquote key={key++}>{renderInline(quote.join("\n"))}</blockquote>);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w.+-]*)\s*$/);
    if (fence) {
      flushAll();
      const closer = fence[1];
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(closer)) {
        body.push(lines[i]);
        i++;
      }
      // Wrapped so the copy button has somewhere to sit that is not inside
      // the <pre> — a button in there gets selected along with the code and
      // ends up in whatever somebody copies by hand.
      const code = body.join("\n");
      // An empty fence is not a code block. They arrive when a turn's tool
      // block is lifted out of the prose and the fence markers are left
      // behind, and they rendered as an empty bordered box — easy to miss
      // until a copy button appeared on one and there was nothing to copy.
      if (!code.trim()) continue;
      blocks.push(
        <div key={key++} className="md-code-wrap">
          <pre className="md-code" data-lang={lang || undefined}>
            <code>{code}</code>
          </pre>
          <CopyButton text={code} className="md-copy" />
        </div>
      );
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(
        React.createElement(`h${level}`, { key: key++ }, renderInline(heading[2]))
      );
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={key++} />);
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const marker: "ul" | "ol" = bullet ? "ul" : "ol";
      if (list.length && list[0].marker !== marker) flushList();
      list.push(
        bullet
          ? { marker, text: bullet[1] }
          : { marker, text: numbered![2], number: Number(numbered![1]) }
      );
      continue;
    }

    // Continuation of a list item, indented under it.
    if (list.length && /^\s{2,}/.test(line)) {
      list[list.length - 1].text += `\n${line.trim()}`;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }
  flushAll();

  return <div className="markdown">{blocks}</div>;
});
