import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition } from "../types";
import { err, ok, resolveIn, relative } from "./util";
import { findSymbols, symbolName } from "../agent/project-map";

/**
 * "Where is X defined?" in one call.
 *
 * Answered with `grep` it took a guess at the pattern, a page of usages to
 * wade through, and often a second search — each one a round trip to a chat
 * model. The index behind this reads each source file once per session and
 * again only when it changes, so after the first call an answer costs a
 * directory listing and a stat per file.
 */
export const findSymbolTool: ToolDefinition = {
  name: "find_symbol",
  description:
    "Find where a function, class, method, type or constant is defined, by name: path:line and the defining line. Faster than grep when you know the name; grep finds usages.",
  // `symbol`, not `name`: in a block, `name:` is also a way of writing
  // `tool:`, and a parameter that shares it is one misreading away from
  // being taken for the tool. `name` is still accepted.
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "The name to look up, e.g. runTurn or Engine.start" },
      path: { type: "string", description: "Folder to search (defaults to the working directory)" },
    },
    required: ["symbol"],
  },
  async run(args, ctx) {
    const query = String(args.symbol ?? args.name ?? args.query ?? "").trim();
    if (!query) return err("`symbol` must be the name to look up, e.g. `symbol: runTurn`.");
    const root = resolveIn(ctx.cwd, args.path);
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch {
      return err(`Folder not found: ${relative(ctx.cwd, root)}. Leave \`path\` out to search the working directory.`);
    }
    if (!isDir) {
      return err(`${relative(ctx.cwd, root)} is a file. Pass the folder to search as \`path\`, or leave it out.`);
    }

    const found = findSymbols(root, query, { signal: ctx.signal });
    if (found.unsearchable) {
      return err(
        `${root} is a home directory or a drive root, which is not indexed. Pass a project folder as \`path\`, or use grep.`
      );
    }
    const shown = (file: string) => relative(ctx.cwd, path.join(root, file));
    const notes: string[] = [];
    if (found.partial) notes.push("The index did not cover every file in time; a definition may be missing — grep can confirm.");
    if (found.match === "none") {
      return ok(
        [
          `No definition of \`${query}\` found in ${found.files} source file${found.files === 1 ? "" : "s"}. ` +
            "It may be defined in a way the index does not read (assigned at runtime, generated, or in a language it does not parse), " +
            `or under another name. grep for it: \`pattern: ${symbolName(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`.`,
          ...notes,
        ].join("\n"),
        { title: `${query} (not found)` }
      );
    }
    const lines = found.hits.map((hit) => `${shown(hit.file)}:${hit.line}  ${hit.kind}  ${hit.text}`);
    if (found.match === "case") notes.unshift(`No exact match for \`${query}\`; these match ignoring case.`);
    if (found.match === "partial") notes.unshift(`No definition named exactly \`${query}\`; these names contain it.`);
    if (found.more) notes.push(`… ${found.more} more — use a fuller name, or pass a folder as \`path\`.`);
    const count = found.hits.length + found.more;
    return ok([...lines, ...notes].join("\n"), {
      title: `${query} (${count} definition${count === 1 ? "" : "s"})`,
      display: { kind: "text", lines: [...lines, ...notes] },
    });
  },
};

export const SYMBOL_TOOLS: ToolDefinition[] = [findSymbolTool];
