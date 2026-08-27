import React from "react";
import type { FileDiff } from "../../../shared/protocol";

export function DiffView({
  diff,
  showHeader = true,
}: {
  diff: FileDiff;
  showHeader?: boolean;
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
              {marker} {line.text}
            </span>
          </div>
        );
      })}
      {diff.truncated && <div className="truncated">diff truncated…</div>}
    </div>
  );
}
