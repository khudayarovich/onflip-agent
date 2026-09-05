import React from "react";
import type { FileDiff } from "../../../shared/protocol";
import { splitOnMatches } from "../../../shared/diff-search";

/** A line's text with every occurrence of `query` marked. */
function Highlighted({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!query) return <>{text}</>;
  return (
    <>
      {splitOnMatches(text, query).map((part, i) =>
        part.hit ? (
          <mark key={i} className="diff-hit">
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
}

export function DiffView({
  diff,
  showHeader = true,
  highlight = "",
}: {
  diff: FileDiff;
  showHeader?: boolean;
  /** Search term to mark within each line, if any. */
  highlight?: string;
}): React.ReactElement {
  if (diff.unavailable) {
    return (
      <div className="diff">
        {showHeader && <div className="file-head"><span>{diff.rel}</span></div>}
        <div className="modal-note">
          Diff unavailable because the saved snapshot omitted the file contents.
        </div>
      </div>
    );
  }
  return (
    <div className="diff">
      {showHeader && (
        <div className="file-head">
          <span>{diff.rel}</span>
          <span className="stats-add">+{diff.added}</span>
          <span className="stats-del">−{diff.removed}</span>
        </div>
      )}
      {diff.lines.map((line, i) => {
        if (line.kind === "gap") {
          return (
            <div key={i} className="diff-line gap">
              <span className="ln" />
              <span className="code">⋯</span>
            </div>
          );
        }
        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
        return (
          <div key={i} className={`diff-line ${line.kind}`}>
            <span className="ln">{line.newLine ?? line.oldLine ?? ""}</span>
            <span className="code">
              {marker} <Highlighted text={line.text} query={highlight} />
            </span>
          </div>
        );
      })}
      {diff.truncated && <div className="truncated">diff truncated…</div>}
    </div>
  );
}
