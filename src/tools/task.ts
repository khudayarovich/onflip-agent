import { ToolDefinition } from "../types";


/**
 * Handing a piece of work to a second agent with its own conversation.
 *
 * The case for it is narrow and worth stating, because a sub-agent used for
 * the wrong thing costs more than it saves. Some work reads a great deal and
 * concludes a little: find where a setting is handled across forty files,
 * work out why a test fails, survey what a dependency actually exports. Done
 * in the main conversation, every file it reads stays there — and this app's
 * measured logs say tool output is most of what fills a transcript, which is
 * what forces the summarising that costs a request, a fresh chat and a full
 * replay.
 *
 * A sub-agent does that reading somewhere else and brings back the answer.
 * The main conversation gains a paragraph instead of thirty file listings.
 *
 * What it costs, said plainly because the model has to weigh it: the
 * sub-agent needs a conversation of its own, and OnFlip drives one chat at a
 * time, so the parent's thread is abandoned and rebuilt on its next message.
 * That is roughly what one compaction costs. Worth it for work that would
 * have filled the transcript; not worth it for a single file read.
 */

export interface SubAgentRequest {
  description: string;
  prompt: string;
  signal: AbortSignal;
  onProgress?(line: string): void;
}

export interface SubAgentResult {
  answer: string;
  steps: number;
  /** Set when it stopped without finishing — out of steps, or interrupted. */
  stopped?: string;
}

export type SubAgentRunner = (req: SubAgentRequest) => Promise<SubAgentResult>;

/**
 * The tool, when there is something able to run one.
 *
 * Absent otherwise, on the same principle as `send_file`: a tool the model
 * can call and nothing can carry out is worse than no tool.
 */
export function taskTools(run: SubAgentRunner | undefined): ToolDefinition[] {
  if (!run) return [];
  return [
    {
      name: "task",
      description:
        "Hand a self-contained piece of work to a second agent that has its own conversation, and get back only its answer. " +
        "Use it for work that reads a lot and concludes a little: finding where something is handled across many files, " +
        "working out why a test fails, surveying an unfamiliar dependency. The files it reads stay out of this conversation, " +
        "which is what makes it worth doing. " +
        "It has the same tools you do and works in the same folder, but it cannot see this conversation — so the prompt has to " +
        "stand on its own, and it can neither ask you a question nor hand work back half-finished. " +
        "Do not use it for a single file read or one command: it costs this conversation a restart, which is about what one " +
        "summarisation costs, and it cannot be worth that for work you could do in one step.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Three to five words naming the work, shown to the user while it runs.",
          },
          prompt: {
            type: "string",
            description:
              "The whole task, written for someone who cannot see this conversation: what to find out or do, " +
              "which files or commands to start from, and what the answer should contain.",
          },
        },
        required: ["description", "prompt"],
      },
      async run(args, ctx) {
        const description = String(args.description ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) {
          return {
            output: "task needs a prompt: the whole piece of work, written for someone who cannot see this conversation.",
            error: true,
          };
        }

        const result = await run({
          description: description || "a sub-task",
          prompt,
          signal: ctx.signal,
          onProgress: (line) => ctx.onProgress?.(line),
        });

        // The answer is the point; the step count is context for judging it,
        // and an unfinished run has to say so or its partial answer reads as
        // a complete one.
        const head = result.stopped
          ? `[the sub-agent stopped after ${result.steps} steps: ${result.stopped}]`
          : `[sub-agent finished in ${result.steps} steps]`;
        return { output: `${head}\n\n${result.answer || "(it returned no answer)"}` };
      },
    },
  ];
}
