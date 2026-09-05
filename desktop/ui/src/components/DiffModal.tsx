import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../../../shared/protocol";
import { countMatches, filterDiffs, takeLines } from "../../../shared/diff-search";
import { api } from "../api";
import { Modal } from "./common";
import { DiffView } from "./DiffView";
import { Search, Close } from "./icons";

/**
 * Everything that changed this session.
 *
 * Rendered a page at a time. The engine now sends whole diffs rather than the
 * first six hundred lines of each, and handing React thirty thousand rows on
 * open would trade one unusable modal for another — so a chunk is rendered,
 * and the next chunk when the bottom of the list comes into view.
 *
 * Search filters to matching lines across every file, including lines that
 * have not been rendered yet: the filter runs over the data, not over the
 * DOM, so a match in the twentieth file is found without scrolling to it.
 */

/** Lines per page. Large enough to fill the modal, small enough to mount fast. */
const PAGE = 400;

export function DiffModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api
      .sessionDiff()
      .then(setDiffs)
      .catch((e: Error) => setError(e.message));
  }, []);

  const visible = useMemo(() => filterDiffs(diffs ?? [], query), [diffs, query]);
  const matches = useMemo(() => countMatches(diffs ?? [], query), [diffs, query]);
  const page = useMemo(() => takeLines(visible, limit), [visible, limit]);

  // A new search starts at the top; keeping the old limit would show a
  // hundred pages of two matches, or hide the first match below the fold.
  useEffect(() => setLimit(PAGE), [query]);

  // Load the next page when the end of the list is reached. The scroller is
  // the modal body, not the window, so it has to be named explicitly —
  // with the default root the sentinel is "visible" from the start and every
  // page loads at once.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !page.more) return;
    const root = node.closest(".modal-body");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((n) => n + PAGE);
      },
      { root, rootMargin: "600px" }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [page.more, page.shown]);

  const searching = query.trim().length > 0;

  return (
    <Modal title="Changes this session" onClose={onClose} wide>
      {diffs && diffs.length > 0 && (
        <div className="diff-search">
          <Search size={13} />
          <input
            autoFocus
            value={query}
            placeholder="Search in changes"
            aria-label="Search in changes"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the search rather than closing the modal, which
              // is what it does in every other search box; a second press
              // reaches the modal and closes it.
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery("")} aria-label="Clear search">
              <Close size={11} />
            </button>
          )}
          <span className="diff-count">
            {searching
              ? matches === 0
                ? "no matches"
                : `${matches} ${matches === 1 ? "match" : "matches"} in ${visible.length} ${
                    visible.length === 1 ? "file" : "files"
                  }`
              : `${diffs.length} ${diffs.length === 1 ? "file" : "files"}`}
          </span>
        </div>
      )}

      {error && <div className="msg-error">{error}</div>}
      {diffs && diffs.length === 0 && (
        <div className="modal-note">No files changed this session.</div>
      )}
      {searching && visible.length === 0 && diffs && diffs.length > 0 && (
        <div className="modal-note">Nothing in these changes matches “{query}”.</div>
      )}

      {page.diffs.map((diff) => (
        <div key={diff.path} style={{ marginBottom: 22 }}>
          <DiffView diff={diff} highlight={query} />
        </div>
      ))}

      {page.more && (
        <div className="diff-more" ref={sentinel}>
          Loading the rest… {page.shown.toLocaleString()} of {page.total.toLocaleString()} lines
        </div>
      )}
    </Modal>
  );
}
