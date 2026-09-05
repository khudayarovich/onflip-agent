import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "./icons";
import { useT } from "../i18n";

/**
 * Copy something, and say that it worked.
 *
 * The saying-so is the point. A copy button with no feedback leaves people
 * pressing it twice to be sure, and on a code block — where the alternative
 * is selecting exactly the right lines with a mouse — being sure is most of
 * the value.
 */
export function CopyButton({
  text,
  className,
  size = 13,
  label,
}: {
  text: string;
  className?: string;
  size?: number;
  /** Overrides the tooltip, for buttons whose context is not obvious. */
  label?: string;
}): React.ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // A button unmounted while its tick is showing — a message replaced by a
  // stream update, say — must not set state afterwards.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (e: React.MouseEvent) => {
    // These sit inside clickable rows; copying is not also selecting.
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access can be refused; the textarea trick still works and
      // is the difference between a button that fails and one that does not.
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing else to try */
      }
      scratch.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
      title={copied ? t("copied") : (label ?? t("copy"))}
      aria-label={copied ? t("copied") : (label ?? t("copy"))}
      onClick={(e) => void copy(e)}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
