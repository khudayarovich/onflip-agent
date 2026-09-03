import { ToolDefinition } from "../types";
import { err } from "./util";

/**
 * The two ways a turn ends.
 *
 * A reply with no onflip block used to be the final answer by definition,
 * and the lighter models ended turns that way constantly — "I'll verify the
 * build now." as the whole reply, and the build never run. Every fix was
 * another verb pattern over the prose, then the same patterns in Russian and
 * Uzbek, and every session found a sentence the patterns had not seen.
 * Cline, OpenHands, SWE-agent and smolagents all settled the same problem
 * the same way: finishing is an explicit action the model takes, and a reply
 * that takes no action at all is a protocol error the harness answers with
 * a nudge rather than a guess. These are those actions.
 *
 * Neither runs anything. The agent loop intercepts them before dispatch and
 * ends the turn. `run` exists so that a registry handed one anyway — a
 * replay, a test, a stray dispatch — answers with something actionable
 * rather than "unknown tool", which would tell the model that the closing
 * block it was instructed to use does not exist.
 */
export const TERMINAL_TOOL_NAMES = ["done", "ask_user"] as const;

export type TerminalToolName = (typeof TERMINAL_TOOL_NAMES)[number];

export function isTerminalTool(name: string): name is TerminalToolName {
  return (TERMINAL_TOOL_NAMES as readonly string[]).includes(name);
}

export const TERMINAL_TOOLS: ToolDefinition[] = [
  {
    name: "done",
    description:
      "End the turn: the user's request is complete. `summary` is your final answer to the user, in Markdown — the outcome first, files as path:line, and anything you left out and why. " +
      "Use it only when the whole request is finished and verified: never after a single step, never while an item on your task list is still open (mark it completed or cancelled first), and never right after a failed tool call.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "The final answer, exactly as the user should read it.",
        },
      },
      required: ["summary"],
    },
    async run() {
      return err(
        "done is not run as a tool; the agent loop ends the turn on it. Emit the done block alone, in its own reply, once every tool result you need has come back."
      );
    },
  },
  {
    name: "ask_user",
    description:
      "End the turn with a question you cannot proceed without — a real choice about what to do, which only the user can make. " +
      "Never use it to ask permission to run a tool: OnFlip approves tool calls itself, so emit the call instead.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, with enough context to answer it.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional answers to choose from, one per item.",
        },
      },
      required: ["question"],
    },
    async run() {
      return err(
        "ask_user is not run as a tool; the agent loop ends the turn on it. Emit the ask_user block alone, in its own reply."
      );
    },
  },
];
