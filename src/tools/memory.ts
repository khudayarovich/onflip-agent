import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition } from "../types";
import { err, denied } from "./util";

/**
 * Durable project memory.
 *
 * Facts the agent records land in `.onflip/memory.md` in the workspace, which
 * `loadProjectContext` folds into the system prompt of every later session —
 * so "the tests need the dev server running" survives the conversation that
 * discovered it. Deliberately append-only from the tool's side: pruning a
 * memory is an editorial decision, and the file is plain Markdown the user
 * can edit with anything.
 */

const MEMORY_FILE = path.join(".onflip", "memory.md");
const MAX_MEMORY_BYTES = 16_000;

export const rememberTool: ToolDefinition = {
  name: "remember",
  description:
    "Save a short durable fact about this project to .onflip/memory.md, which is loaded into every future session. Use for non-obvious things worth keeping: how to run it, gotchas discovered the hard way, decisions the user made. One fact per call, one sentence or two.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The fact to remember, phrased to make sense on its own" },
    },
    required: ["fact"],
  },
  mutates: true,
  async run(args, ctx) {
    const fact = String(args.fact ?? "").trim().replace(/\s+/g, " ");
    if (!fact) return err("`fact` must be non-empty");
    if (fact.length > 500) {
      return err("Keep a memory under 500 characters — record the essence, not the transcript.");
    }

    const file = path.resolve(ctx.cwd, MEMORY_FILE);
    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "remember",
      subject: fact,
      targetPath: file,
    });
    if (!decision.allow) return denied("Memory", decision.reason);

    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      /* first memory */
    }
    if (existing.includes(fact)) {
      return { output: "Already remembered — the fact is in .onflip/memory.md verbatim.", title: "memory" };
    }
    if (existing.length + fact.length > MAX_MEMORY_BYTES) {
      return err(
        ".onflip/memory.md is full (16KB). Read it and rewrite it smaller with `edit` before adding more — prune what no longer matters."
      );
    }

    const header = existing.trim() ? "" : "# Project memory\n\nRecorded by OnFlip; loaded into every session. Edit freely.\n\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${header}- ${fact}\n`, "utf8");
    return {
      output: `Remembered. It will be part of the context from the next session on (this session's prompt is already built).`,
      title: fact.slice(0, 60),
    };
  },
};

export const MEMORY_TOOLS: ToolDefinition[] = [rememberTool];
