/**
 * What the "writing" line shows while a reply streams in.
 *
 * Protocol fences are hidden, tool calls become a short label, and a closing
 * block's Markdown body streams as the answer itself. Fence identity matters:
 * a four-backtick onflip block may legitimately contain three-backtick code
 * fences, which are content rather than the end of the call.
 */
export function presentableTail(full: string): string {
  const lines = full.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let fenceLength = 0;
  let fenceIndent = 0;
  let fenceIsOurs = false;
  let fenceIsCall = false;
  let fenceTool = "";
  let fenceStart = -1;
  let closingBody: string[] = [];
  let inClosingBody = false;

  const flush = (label: string): void => {
    const replacement = isClosingBlock(fenceTool) && closingBody.length ? closingBody : [label];
    out.splice(fenceStart, out.length - fenceStart, ...replacement);
  };

  for (const line of lines) {
    const candidate = line.match(/^(\s*)(`{2,}|~{2,})([^\r\n]*)$/);
    if (!inFence && candidate && candidate[2].length >= 3) {
      inFence = true;
      fenceMarker = candidate[2][0];
      fenceLength = candidate[2].length;
      fenceIndent = candidate[1].length;
      fenceIsOurs = /^(?:onflip|onflip:tool)(?:\s|$)/i.test(candidate[3].trim());
      fenceIsCall = false;
      fenceTool = "";
      fenceStart = out.length;
      closingBody = [];
      inClosingBody = false;
      continue;
    }

    if (inFence && candidate && !candidate[3].trim()) {
      const normalClose =
        candidate[2][0] === fenceMarker &&
        candidate[2].length >= fenceLength &&
        candidate[1].length <= fenceIndent;
      const shortOwnedClose =
        fenceIsOurs &&
        candidate[1].length === 0 &&
        candidate[2][0] === fenceMarker &&
        candidate[2].length >= 2;
      if (normalClose || shortOwnedClose) {
        inFence = false;
        if (fenceIsCall) flush(`▸ ${fenceTool || "tool"} call`);
        continue;
      }
    }

    if (inFence && !fenceIsCall && out.length === fenceStart) {
      const tool = /^\s*tool\s*:\s*([A-Za-z0-9_.-]+)/i.exec(line);
      if (tool) {
        fenceIsCall = true;
        fenceTool = tool[1];
        continue;
      }
    }
    if (inFence && fenceIsCall) {
      if (isClosingBlock(fenceTool)) {
        const inline = /^\s*(?:summary|question)\s*:\s*(\S.*)$/i.exec(line);
        if (/^\s*(?:summary|question)\s*:\s*[|>]?\s*$/i.test(line)) {
          inClosingBody = true;
        } else if (inline && !/^[|>]$/.test(inline[1].trim())) {
          closingBody.push(inline[1]);
          inClosingBody = false;
        } else if (inClosingBody && /^\s+\S/.test(line)) {
          closingBody.push(line.replace(/^ {1,2}/, ""));
        } else if (inClosingBody && !line.trim()) {
          closingBody.push("");
        } else {
          inClosingBody = false;
        }
      }
      continue;
    }
    out.push(line);
  }
  if (inFence && fenceIsCall) flush(`▸ writing a ${fenceTool || "tool"} call…`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd().slice(-240);
}

function isClosingBlock(tool: string): boolean {
  return /^(?:done|finish|final_answer|attempt_completion|complete|completed|submit|final|end_turn|ask_user|ask|ask_followup_question|ask_question|question|clarify)$/i.test(
    tool.replace(/[-\s]/g, "_")
  );
}
