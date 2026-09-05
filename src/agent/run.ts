import { ChatMessage, ToolCall, ToolResult, SessionState } from "../types";
import { listJobs, ToolRegistry } from "../tools";
import { isTerminalTool, TerminalToolName, TERMINAL_TOOL_NAMES } from "../tools/terminal";
import { Transport, SendOptions, TransportReply, ReplyMeta } from "../chatgpt/transport";
import { newMessage, parseTurn, formatToolResult, isUserRequest } from "./protocol";
import {
  turnReminder,
  protocolCorrection,
  noBlockNudge,
  doneWithOpenTodosNudge,
  truncationNudge,
  compactInstruction,
  SlipVariant,
} from "./system";
import { logger } from "../log";
import {
  classifyFailure,
  failureCodeOf,
  startCooldown,
  clearCooldown,
  describeWait,
  serviceMessage,
} from "../chatgpt/backoff";

/**
 * The agent loop.
 *
 * One call to `runTurn` handles a single user request. Inside it the model may
 * go around the loop many times — each iteration is one model reply plus the
 * tool calls it asked for.
 *
 * A turn ends structurally, not by reading the prose. The model closes it
 * with a `done` block (the final answer) or an `ask_user` block (a question
 * only the user can settle); a reply with neither and no tool call is a
 * protocol error, answered with an automated nudge and then — so nothing the
 * model wrote is ever lost — accepted as the answer. The loop also ends when
 * the step budget runs out or the user interrupts.
 *
 * It used to end on any reply without a tool call, and a bank of verb
 * patterns tried to tell a final answer from "I'll verify the build now."
 * Every session found a sentence the patterns had not seen — in English,
 * then in Russian and Uzbek — and each miss ended the run with the plan
 * unfinished. The patterns that survive are hints about *which* nudge to
 * send; none of them decides whether the turn is over.
 */

export interface FinalMeta {
  /** How the turn ended: the model's own closing block, or accepted prose. */
  kind: "done" | "ask_user" | "prose";
  /** Task-list items still open when it ended. */
  openTodos: number;
  /** Choices offered with an `ask_user` question. */
  options?: string[];
}

export interface AgentEvents {
  /** The model is being queried; `iteration` is 1-based. */
  onThinking?(iteration: number): void;
  /** Partial reply text as it streams in. */
  onDelta?(fullText: string): void;
  /** Prose the model emitted alongside tool calls (not the final answer). */
  onNarration?(text: string): void;
  onToolStart?(call: ToolCall): void;
  onToolEnd?(call: ToolCall, result: ToolResult): void;
  /** Out-of-band status: retries, compaction, protocol corrections. */
  onNotice?(text: string): void;
  /**
   * Messages compaction just removed from the context.
   *
   * The caller may want to keep showing them: summarising is about what is
   * *sent*, and a transcript that empties itself looks like lost work.
   */
  onCompacted?(dropped: ChatMessage[]): void;
  /** The model's final answer, or its question to the user. */
  onFinal?(text: string, meta?: FinalMeta): void;
}

export interface AgentOptions {
  transport: Transport;
  tools: ToolRegistry;
  session: SessionState;
  model: string;
  thinking?: string;
  maxIterations: number;
  shellEnabled: boolean;
  signal: AbortSignal;
  events?: AgentEvents;
  /** Compact the conversation once it grows past this many messages. */
  compactAfterMessages?: number;
  /**
   * Compact once the transcript grows past this many characters.
   *
   * The better of the two triggers by a wide margin. A message count says
   * nothing about what is in the messages: one session ran 98 tool calls
   * carrying 127k characters between them, and a single file read outweighs
   * twenty short exchanges.
   */
  compactAfterChars?: number;
}

/** Why a turn stopped, for the log and for the stats over it. */
export type TurnEnd =
  | "done"
  | "ask_user"
  /** Block-less prose accepted after the nudges were spent. */
  | "prose"
  /** The model sent the same block-less reply twice; nudging it again was pointless. */
  | "repeat"
  | "exhausted"
  | "interrupted";

export interface AgentTurnResult {
  finalAnswer: string;
  iterations: number;
  /** True when the loop stopped because the step budget ran out. */
  exhausted: boolean;
  interrupted: boolean;
  endedBy: TurnEnd;
}

const MAX_TRANSPORT_RETRIES = 2;
/** Malformed calls re-requested before the turn is failed. */
const MAX_PROTOCOL_CORRECTIONS = 2;
/**
 * Block-less replies answered with a nudge before the prose is accepted.
 *
 * Two, like the corrections: the first reminder is usually enough, the
 * second settles a model that answered the first conversationally, and a
 * third has never changed anything. Resets once a tool runs, because a
 * reply that acts is the model back on protocol.
 */
const MAX_NO_BLOCK_NUDGES = 2;
/** Every automated message of a turn together, so alternating slips cannot loop. */
const MAX_NUDGES_PER_TURN = 6;
/** Replies ChatGPT reported as cut off that are re-requested before being used as they are. */
const MAX_TRUNCATION_NUDGES = 2;

/**
 * Run one user turn to completion.
 *
 * `history` is mutated in place so the caller keeps the transcript even when
 * the turn is interrupted — a half-finished turn still contains real tool
 * results that the next turn needs to see.
 */
export async function runTurn(
  history: ChatMessage[],
  opts: AgentOptions
): Promise<AgentTurnResult> {
  const events = opts.events ?? {};
  /** Corrections and nudges since the last reply that acted; resets when a tool runs. */
  let protocolCorrections = 0;
  /** Every automated message this turn, never reset. */
  let totalNudges = 0;
  /** The one reminder a `done` with open task-list items gets. */
  let doneNudged = false;
  let truncationNudges = 0;
  /** Tool calls actually executed this turn; gates fabrication detection. */
  let executedCalls = 0;
  /** Tool calls the policy refused this turn; gates permission-slip detection. */
  let deniedCalls = 0;
  /** Identical calls that have already failed, so a repeat can be named as one. */
  const failedCalls = new Map<string, number>();
  /**
   * Prose from block-less replies that were nudged rather than shown.
   *
   * A long answer followed, after the nudge, by a bare `done` block is that
   * answer plus a one-line summary: the answer has to survive to the final
   * message. It is emptied once a tool runs, at which point it was
   * narration, and is shown as such.
   */
  let pendingProse = "";
  /** The last block-less reply, squashed, so an identical resend is recognised. */
  let lastNoCallText = "";
  // Telemetry for the "turn finished" line.
  let noBlockReplies = 0;
  let truncatedReplies = 0;
  const acceptedVia: Record<string, number> = {};
  // What the registry answers to, aliases included, so an unfenced `tool:`
  // line naming anything else is read as the prose it is.
  const knownTool = toolKnownTo(opts.tools);
  const terminalName = (call: ToolCall): TerminalToolName | null =>
    terminalNameOf(opts.tools, call.tool);

  const finish = (endedBy: TurnEnd, finalAnswer: string, iterations: number): AgentTurnResult => {
    logger.info("agent", "turn finished", {
      endedBy,
      iterations,
      nudges: totalNudges,
      noBlockReplies,
      doneNudged,
      truncatedReplies,
      openTodos: openTodoCount(opts.session.todos),
      acceptedVia,
    });
    return {
      finalAnswer,
      iterations,
      exhausted: endedBy === "exhausted",
      interrupted: endedBy === "interrupted",
      endedBy,
    };
  };

  // A non-numeric budget would make `iteration <= budget` false on the first
  // comparison, so the loop would fall straight through and report a turn that
  // never happened. Refuse to run on a nonsense value rather than no-op.
  const budget = Number(opts.maxIterations);
  if (!Number.isFinite(budget) || budget < 1) {
    throw new Error(
      `Invalid step budget (${String(opts.maxIterations)}). Set a positive number in Settings → Step budget.`
    );
  }

  // Set when a compaction failed to shrink anything, so a transcript that is
  // over budget for some other reason cannot put the turn in a loop.
  let compactionExhausted = false;

  for (let iteration = 1; iteration <= budget; iteration++) {
    if (opts.signal.aborted) return finish("interrupted", "", iteration - 1);

    // Checked before every send, not once per user turn. A single turn can run
    // dozens of iterations and add a hundred messages, and that long turn is
    // exactly the one that needs compacting — the old check ran before the
    // first send and could not see the turn grow underneath it. Measured on a
    // session that ran out of room mid-task: 53 iterations, 219k characters
    // sent, not one compaction.
    if (!compactionExhausted) {
      compactionExhausted = (await compactIfLarge(history, opts, events)) === "no-gain";
    }

    events.onThinking?.(iteration);

    let reply: TransportReply;
    try {
      reply = await sendWithRetry(history, opts, events);
    } catch (e) {
      if (opts.signal.aborted) return finish("interrupted", "", iteration);
      throw e;
    }
    const raw = reply.content;
    const meta: ReplyMeta = reply.meta ?? {};
    if (meta.acceptedVia) acceptedVia[meta.acceptedVia] = (acceptedVia[meta.acceptedVia] ?? 0) + 1;
    if (meta.truncated) truncatedReplies++;

    history.push(newMessage("assistant", raw));

    let { text, calls, malformed } = parseTurn(raw, knownTool);

    // A reply carrying our own instructions is the page handing back what
    // we sent. Its 'tool calls' are the worked examples out of the prompt,
    // and running them writes files nobody asked for.
    if (calls.length > 0 && looksLikeOwnPayload(raw)) {
      logger.warn("protocol", "reply contained our own prompt", {
        chars: raw.length,
        calls: calls.map((c) => c.tool),
      });
      calls = [];
      malformed =
        "the reply came back containing OnFlip's own instructions rather than an answer.";
    }

    // The closing blocks are the loop's to act on, never the registry's.
    const terminal = calls.find((c) => terminalName(c) !== null) ?? null;
    const realCalls = calls.filter((c) => terminalName(c) === null);
    const openTodos = openTodoLines(opts.session.todos);

    logger.info("agent", `iteration ${iteration} parsed`, {
      calls: realCalls.map((c) => c.tool),
      terminal: terminal ? terminalName(terminal) : null,
      proseChars: text.length,
      malformed: malformed ?? null,
      truncated: Boolean(meta.truncated),
    });

    // ---- a reply ChatGPT itself reported as cut off ------------------------
    // Nothing in it can be trusted whole: a `write` whose content stopped at
    // the length limit would put half a file on disk, and a `done` after it
    // would call that finished. ChatGPT's own "Continue generating" has
    // already been tried by the transport; this is the fallback, asking the
    // model to send the reply again complete.
    if (meta.truncated && truncationNudges < MAX_TRUNCATION_NUDGES && totalNudges < MAX_NUDGES_PER_TURN) {
      truncationNudges++;
      totalNudges++;
      logger.warn("protocol", "reply was truncated; asking for it again", {
        attempt: truncationNudges,
        chars: raw.length,
      });
      events.onNotice?.(
        `ChatGPT's reply was cut off at its length limit — asking for it again (${truncationNudges} of ${MAX_TRUNCATION_NUDGES}).`
      );
      history.push(newMessage("user", truncationNudge({ attempt: truncationNudges })));
      continue;
    }

    // ---- tool calls: run them ---------------------------------------------
    if (realCalls.length > 0) {
      protocolCorrections = 0;
      lastNoCallText = "";
      // What the nudged replies said was narration after all: the model went
      // on to act. Shown now, in order, so the transcript reads as it happened.
      if (pendingProse) {
        events.onNarration?.(pendingProse);
        pendingProse = "";
      }
      if (text.trim()) events.onNarration?.(text.trim());

      const resultBlocks: string[] = [];
      for (const call of realCalls) {
        if (opts.signal.aborted) {
          // Keep whatever already ran so the transcript stays truthful.
          if (resultBlocks.length) {
            history.push(newMessage("user", resultBlocks.join("\n\n")));
          }
          return finish("interrupted", "", iteration);
        }

        events.onToolStart?.(call);
        logger.info("tool", `run ${call.tool}`, { args: loggableArguments(call) });
        const startedAt = Date.now();
        const result = await opts.tools.run(call.tool, call.arguments);
        // A failure logs *why*, at warn, and not only that it happened.
        // Measured across every session in `~/.onflip/logs`: 16% of all tool
        // calls fail, and `edit` fails 57% of the time (71 of 125) with
        // `multi_edit` at 18 of 18 — and none of it was diagnosable, because
        // the only thing recorded was `error: true`. The tool's message is
        // the first line of its output; that is what the model is reacting
        // to, so that is what has to be in the log next to the arguments.
        if (result.error && !result.denied) {
          logger.warn("tool", `failed ${call.tool}`, {
            ms: Date.now() - startedAt,
            args: loggableArguments(call),
            reason: result.output.split("\n", 1)[0].slice(0, 300),
          });
        }
        logger.info("tool", `done ${call.tool}`, {
          ms: Date.now() - startedAt,
          error: Boolean(result.error),
          denied: Boolean(result.denied),
          outputChars: result.output.length,
        });
        logger.debug("tool", `output ${call.tool}`, { output: result.output });
        events.onToolEnd?.(call, result);
        executedCalls++;
        if (result.denied) deniedCalls++;

        // Watching a model send the same failing call four times in a row is
        // watching it spend the step budget on a result it has already been
        // given. The tool's own message clearly is not landing by repetition, so
        // say plainly that it is a repetition.
        let output = result.output;
        if (result.error && !result.denied) {
          const signature = `${call.tool}:${JSON.stringify(call.arguments ?? {})}`;
          const attempts = (failedCalls.get(signature) ?? 0) + 1;
          failedCalls.set(signature, attempts);
          if (attempts > 1) output = `${output}\n\n${repeatedCallAdvice(call.tool, attempts)}`;
        }

        resultBlocks.push(formatToolResult(call, output, Boolean(result.error)));
      }

      // A closing block beside tool calls closes nothing: the model wrote
      // its summary before seeing what the calls returned. The calls ran;
      // the block is named so it is sent again, alone, once they are in.
      if (terminal) {
        const name = terminalName(terminal);
        logger.info("protocol", "closing block ignored beside tool calls", { block: name });
        resultBlocks.push(
          `[OnFlip] The ${name} block in that reply was ignored: it arrived beside tool calls whose results you had not seen. ` +
            `Read the results above, and when the turn really is over send the ${name} block alone, in its own reply.`
        );
      }

      history.push(
        newMessage("user", resultBlocks.join("\n\n"), { toolName: realCalls[0].tool })
      );
      continue;
    }

    // ---- a closing block: the model says the turn is over ------------------
    if (terminal) {
      const name = terminalName(terminal)!;
      const open = openTodoCount(opts.session.todos);
      const closingText =
        name === "done"
          ? stringArgument(terminal.arguments.summary)
          : stringArgument(terminal.arguments.question);
      // A closing block that is really a refusal. Live: seven tool calls
      // ran, then an `ask_user` whose question was "the OnFlip execution
      // tool is not exposed in this turn — please reconnect it", and the
      // turn ended on it with three items open. "Expose the tools" is not a
      // question the user can answer and "I cannot proceed without them" is
      // not an answer, so the same nudges apply as to a reply with no block.
      const disguised = pickRefusal(
        classifySlip(text, executedCalls, deniedCalls),
        classifySlip(closingText, executedCalls, deniedCalls)
      );
      if (disguised && protocolCorrections < MAX_NO_BLOCK_NUDGES && totalNudges < MAX_NUDGES_PER_TURN) {
        protocolCorrections++;
        totalNudges++;
        pendingProse = composeFinal(pendingProse, text);
        lastNoCallText = squash(`${text}\n${closingText}`);
        const what =
          disguised === "denial"
            ? "ChatGPT replied that it could not use its tools"
            : disguised === "permission"
              ? "ChatGPT asked for permission instead of acting"
              : "ChatGPT tried to hand the task to its own ChatGPT Work agent, which cannot see this computer";
        logger.info("protocol", "closing block carried a refusal; nudging", {
          block: name,
          attempt: protocolCorrections,
          variant: disguised,
          openTodos: open,
        });
        events.onNotice?.(
          `${what} — asking it to continue (${protocolCorrections} of ${MAX_NO_BLOCK_NUDGES}).`
        );
        history.push(
          newMessage(
            "user",
            noBlockNudge({
              tools: opts.tools.list.map((t) => t.name),
              attempt: protocolCorrections,
              variant: disguised,
              openTodos,
              openCount: open,
              closing: name,
            })
          )
        );
        continue;
      }
      if (name === "done") {
        // Done with items still open on its own list is the one shape of
        // stopping short the protocol can see without reading a word. Said
        // once; a second `done` is the model insisting, and it may be right
        // (the list is stale) — the open items are named in the notice.
        if (open > 0 && !doneNudged && totalNudges < MAX_NUDGES_PER_TURN) {
          doneNudged = true;
          totalNudges++;
          events.onNotice?.(
            `ChatGPT said it was done with ${open} task${open === 1 ? "" : "s"} still open on its list — asking it to finish or close them.`
          );
          history.push(newMessage("user", doneWithOpenTodosNudge({ openTodos, openCount: open })));
          continue;
        }
        const summary = stringArgument(terminal.arguments.summary);
        const final = composeFinal(pendingProse, text, summary) || "Done.";
        if (open > 0) {
          events.onNotice?.(
            `ChatGPT finished with ${open} task${open === 1 ? "" : "s"} still open on its list — say "continue" if they matter.`
          );
        }
        events.onFinal?.(final, { kind: "done", openTodos: open });
        return finish("done", final, iteration);
      }
      // ask_user: the question is the final message, options as a list.
      const question = stringArgument(terminal.arguments.question);
      const options = stringList(terminal.arguments.options);
      const asked = [question, ...options.map((o) => `- ${o}`)].filter(Boolean).join("\n");
      const final =
        composeFinal(pendingProse, text, asked) ||
        "ChatGPT ended the turn with a question but left it blank — say how to proceed.";
      events.onFinal?.(final, { kind: "ask_user", openTodos: open, options });
      return finish("ask_user", final, iteration);
    }

    // ---- no block at all: a broken call, or a reply that ends nothing -----
    // A call that was attempted but did not parse must never be shown to the
    // user as an answer — that is how a broken JSON blob ends up on screen
    // instead of the disk usage they asked for.
    if (malformed && protocolCorrections < MAX_PROTOCOL_CORRECTIONS && totalNudges < MAX_NUDGES_PER_TURN) {
      // The raw reply is the only thing that explains a parse failure, so it
      // is recorded at warn level rather than debug — a normal run that goes
      // wrong must leave enough behind to diagnose without reproducing it.
      logger.warn("protocol", "reply did not parse", { reason: malformed, reply: raw });
      protocolCorrections++;
      totalNudges++;
      events.onNotice?.(`Malformed tool call — ${malformed} Asking for a retry.`);
      history.push(
        newMessage("user", protocolCorrection(malformed, { attempt: protocolCorrections }))
      );
      continue;
    }
    // Out of retries on a call that never parsed. The reply is a broken tool
    // call, not an answer, so it is reported as a failure rather than
    // printed at the user as though it were one.
    if (malformed) {
      throw new Error(
        `ChatGPT kept returning a tool call that could not be parsed (${malformed.replace(/\.$/, "")}). ` +
          "This usually means the reply is being mangled in transit. Try /new to start a fresh conversation, or a different model with /model."
      );
    }

    noBlockReplies++;

    // ChatGPT's own service messages come back through the same channel as a
    // reply and read like the agent's answer. Saying whose message it is
    // saves the user debugging OnFlip for something OnFlip did not do — and
    // nudging ChatGPT's error page to "finish properly" would be absurd.
    const service = detectServiceMessage(text);
    if (service) {
      logger.warn("agent", "chatgpt service message", { text: text.trim().slice(0, 300) });
      events.onNotice?.(service);
      const final = composeFinal(pendingProse, text);
      events.onFinal?.(final, { kind: "prose", openTodos: openTodoCount(opts.session.todos) });
      return finish("prose", final, iteration);
    }

    const squashed = squash(text);
    const repeated = Boolean(squashed) && squashed === lastNoCallText;
    const variant = classifySlip(text, executedCalls, deniedCalls);
    const open = openTodoCount(opts.session.todos);

    if (!repeated && protocolCorrections < MAX_NO_BLOCK_NUDGES && totalNudges < MAX_NUDGES_PER_TURN) {
      protocolCorrections++;
      totalNudges++;
      pendingProse = composeFinal(pendingProse, text);
      lastNoCallText = squashed;
      // The long form goes to the model; the person gets one plain line.
      // Reported live: the full correction, repeated on every retry, read
      // as the app shouting at them about a "protocol" they never saw.
      const what =
        variant === "handoff"
          ? "ChatGPT tried to hand the task to its own ChatGPT Work agent, which cannot see this computer"
          : variant === "denial"
            ? "ChatGPT replied that it could not use its tools"
            : variant === "permission"
              ? "ChatGPT asked for permission instead of acting"
              : variant === "fabrication"
                ? "ChatGPT described running something without actually calling a tool"
                : variant === "cut"
                  ? "ChatGPT's reply looks cut off"
                  : open > 0
                    ? `ChatGPT stopped with ${open} task${open === 1 ? "" : "s"} still open on its list`
                    : "ChatGPT replied without closing the turn";
      logger.info("protocol", "no block in reply; nudging", {
        attempt: protocolCorrections,
        variant,
        openTodos: open,
        proseChars: text.length,
      });
      events.onNotice?.(
        `${what} — asking it to continue or finish (${protocolCorrections} of ${MAX_NO_BLOCK_NUDGES}).`
      );
      history.push(
        newMessage(
          "user",
          noBlockNudge({
            tools: opts.tools.list.map((t) => t.name),
            attempt: protocolCorrections,
            variant,
            openTodos,
            openCount: open,
          })
        )
      );
      continue;
    }

    // Nudges spent, or the model sent the same thing twice: the prose is the
    // answer. Saying why is worth more than the acceptance itself — a
    // denial in particular reads to the user as "the app has no tools" when
    // the tools were there and listed all along.
    if (repeated) {
      logger.info("protocol", "block-less reply repeated verbatim; accepting it", { proseChars: text.length });
      events.onNotice?.("ChatGPT sent the same reply again — showing it as the answer.");
    } else if (variant === "denial") {
      logger.warn("agent", "model refused the tool protocol", {
        model: opts.model,
        nudges: protocolCorrections,
      });
      events.onNotice?.(
        `ChatGPT would not use its tools even after ${protocolCorrections} reminders, so nothing was run. ` +
          "The tools were attached the whole time — this is the model declining to follow them, which the lighter models do often. " +
          "Switch to a stronger model with the chip under the composer and send again; asking it to list its OnFlip tools also often breaks the deadlock."
      );
    } else {
      logger.info("protocol", "nudges spent; accepting prose as the answer", {
        nudges: protocolCorrections,
        variant,
        openTodos: open,
      });
      events.onNotice?.(
        `ChatGPT gave no closing block after ${protocolCorrections} reminders — showing its reply as the answer.` +
          (open > 0 ? ` ${open} task${open === 1 ? "" : "s"} on its list ${open === 1 ? "is" : "are"} still open; say "continue" to carry on.` : "")
      );
    }
    const final = composeFinal(pendingProse, text);
    events.onFinal?.(final, { kind: "prose", openTodos: open });
    return finish(repeated ? "repeat" : "prose", final, iteration);
  }

  return finish("exhausted", "", budget);
}

/**
 * Size of the transcript, in characters.
 *
 * A stand-in for how full the model's context is. Rough — characters are not
 * tokens — but it moves with the thing that actually fills a conversation up,
 * which a message count does not.
 */
export function transcriptChars(history: ChatMessage[]): number {
  let chars = 0;
  for (const message of history) chars += message.content.length;
  return chars;
}

/** The part of the transcript compaction can actually shrink. */
export function reducibleChars(history: ChatMessage[]): number {
  let chars = 0;
  for (const message of history) {
    if (message.role !== "system") chars += message.content.length;
  }
  return chars;
}

/** Why this transcript should be compacted, or null to leave it alone. */
export function compactionReason(
  history: ChatMessage[],
  limits: { compactAfterChars?: number; compactAfterMessages?: number }
): string | null {
  // The system prompt is excluded on purpose, and not as a refinement.
  // Compaction keeps it verbatim, so a transcript can never shrink below
  // system-plus-summary — and when the prompt alone sits near the budget,
  // counting it makes the freshly compacted transcript over budget *again*.
  // That exact loop ran for real: compact, open a new chat, re-upload,
  // compact, ten new conversations in ten minutes, until ChatGPT throttled
  // the account. Measuring only what compaction can reclaim makes the loop
  // impossible at any budget.
  const chars = reducibleChars(history);
  if (limits.compactAfterChars && chars > limits.compactAfterChars) {
    return `${Math.round(chars / 1000)}k characters`;
  }
  if (limits.compactAfterMessages && history.length > limits.compactAfterMessages) {
    return `${history.length} messages`;
  }
  return null;
}

/**
 * Compact the transcript if it has grown past either budget.
 *
 * Returns what happened, because "it did not shrink" has to stop the caller
 * asking again: a summary that is somehow larger than what it replaced would
 * otherwise trigger on every single pass and spend the whole step budget
 * summarising.
 */
async function compactIfLarge(
  history: ChatMessage[],
  opts: AgentOptions,
  events: AgentEvents
): Promise<"skipped" | "compacted" | "no-gain"> {
  const reason = compactionReason(history, opts);
  if (!reason) return "skipped";

  const before = transcriptChars(history);
  logger.info("agent", "compacting", { reason, messages: history.length, chars: before });
  events.onNotice?.(`Context is getting long (${reason}) — compacting.`);
  const dropped = await compact(history, opts);
  if (dropped.length) events.onCompacted?.(dropped);

  const after = transcriptChars(history);
  logger.info("agent", "compacted", {
    messages: history.length,
    chars: after,
    saved: before - after,
  });
  if (after >= before) {
    logger.warn("agent", "compaction did not shrink the transcript", { before, after });
    return "no-gain";
  }
  // Shrinking is not the same as shrinking enough. A compaction that leaves
  // the transcript still over budget would fire again on the very next
  // iteration — and each round costs a summary request, a fresh conversation
  // and a full re-upload, which is a request storm ChatGPT answers with a
  // throttle. Once summarising has done what it can, it is done for the turn.
  if (compactionReason(history, opts)) {
    logger.warn("agent", "still over budget after compacting; not compacting again this turn", {
      before,
      after,
    });
    return "no-gain";
  }
  return "compacted";
}

async function sendWithRetry(
  history: ChatMessage[],
  opts: AgentOptions,
  events: AgentEvents
): Promise<TransportReply> {
  const sendOptions: SendOptions = {
    model: opts.model,
    thinking: opts.thinking,
    signal: opts.signal,
    onDelta: events.onDelta,
    // Read per step, not once per turn: a job can exit between two steps of
    // the same turn, and the step after it is the one that needs to know.
    reminder: turnReminder(
      opts.shellEnabled,
      opts.tools.list.map((t) => t.name),
      listJobs(),
      lastUserRequest(history, 200)
    ),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
    try {
      const reply = await opts.transport.send(history, sendOptions);
      if (reply.content.trim()) {
        // A reply that lands is the only proof the block has lifted.
        clearCooldown();
        return reply;
      }
      lastError = new Error("ChatGPT returned an empty reply.");
    } catch (e) {
      lastError = e;
      if (opts.signal.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      // A throttle, a login wall or a Cloudflare challenge will not clear by
      // hammering it, and retrying a throttle actively deepens it. An earlier
      // version matched on the wording and missed the real 403, then retried
      // it twice.
      // The code, when the throw site set one. Only failures without one fall
      // back to matching the sentence, which is how this used to misread its
      // own advice text — see `FailureCode`.
      const failure = classifyFailure(message, failureCodeOf(e));
      if (failure.kind === "cooldown") {
        startCooldown(failure.seconds, failure.reason);
        events.onNotice?.(
          `${failure.reason} Pausing for ${describeWait(failure.seconds * 1000)} — retrying now would extend it.`
        );
        throw e;
      }
      if (failure.kind === "fatal") throw e;
      // A server error page twice from the same thread is that thread, not
      // the moment: measured, three identical retries into one conversation
      // all died at thirty seconds. The next attempt replays into a fresh
      // chat instead, which costs a full resend and is the only retry that
      // has a chance.
      if (attempt >= 1 && attempt < MAX_TRANSPORT_RETRIES && /reached the model/.test(message)) {
        opts.transport.reset();
        events.onNotice?.("That chat keeps failing — the next try starts a fresh one.");
      }
    }

    if (attempt < MAX_TRANSPORT_RETRIES) {
      const waitMs = 2_000 * (attempt + 1);
      // Say what went wrong. "Transport error" on its own gives the user
      // nothing to act on and hides the cause until the retries run out.
      const why = lastError instanceof Error ? lastError.message : String(lastError);
      logger.warn("transport", "send failed, retrying", {
        attempt: attempt + 1,
        error: why,
        stack: lastError instanceof Error ? lastError.stack : undefined,
      });
      events.onNotice?.(
        `${why} — retrying in ${waitMs / 1000}s (${attempt + 1}/${MAX_TRANSPORT_RETRIES})`
      );
      await delay(waitMs, opts.signal);
    }
  }
  const finalMessage = lastError instanceof Error ? lastError.message : String(lastError);
  // Repeated server errors on Auto have one likely cause worth naming: on a
  // paid plan Auto routes an agent's prompts into Pro thinking, and a long
  // silent reasoning pass is what ChatGPT's own front end gives up on at
  // thirty seconds. A fast model does not reach that limit.
  if (/reached the model/.test(finalMessage) && /^auto$/i.test(String(opts.model ?? "").trim())) {
    throw new Error(
      `${finalMessage} It failed ${MAX_TRANSPORT_RETRIES + 1} times in a row, each about thirty seconds in — the shape of a long reasoning pass timing out on ChatGPT's side. ` +
        "The model is set to Auto, which can route into Pro thinking: pick GPT-5.6 Luna (or another fast model) in the chip under the composer and send again."
    );
  }
  throw lastError instanceof Error ? lastError : new Error(finalMessage);
}

/**
 * Whether the registry would resolve a name — aliases and spelling included,
 * since `get` is what the loop itself dispatches through. A registry without
 * one (a scripted fake) falls back to the advertised names plus the closing
 * blocks, which every registry answers to.
 */
function toolKnownTo(tools: ToolRegistry): (name: string) => boolean {
  if (typeof tools.get === "function") return (name) => tools.get(name) !== undefined;
  const names = new Set([
    ...(tools.list ?? []).map((t) => t.name.toLowerCase()),
    ...TERMINAL_TOOL_NAMES,
  ]);
  return (name) => names.has(name.trim().toLowerCase());
}

/**
 * Which closing block a call is, if it is one.
 *
 * Resolved through the registry's own alias table when there is one, so
 * `finish`, `attempt_completion` and `final_answer` — the names other agent
 * protocols use, which a model reaches for out of habit — close the turn
 * exactly as `done` does. A registry without the method (a scripted fake)
 * gets the spelling folded and the two names matched literally.
 */
function terminalNameOf(tools: ToolRegistry, name: string): TerminalToolName | null {
  const canon =
    typeof tools.canonical === "function"
      ? tools.canonical(name)
      : name.trim().toLowerCase().replace(/[-\s]/g, "_");
  return isTerminalTool(canon) ? canon : null;
}

/** An argument as text, whatever shape the model gave it. */
function stringArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * A list argument as strings: a real array, a block scalar with one item
 * per line (with or without `- `), or a single value.
 */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => stringArgument(v).trim()).filter(Boolean);
  const text = stringArgument(value).trim();
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The user-facing message assembled from what the model wrote across the
 * replies that closed a turn: prose it sent before a nudge, prose in front
 * of the closing block, and the block's own summary.
 *
 * Parts are kept in order and de-duplicated by containment, because the
 * summary often repeats the prose word for word — the nudge tells the model
 * not to, and it does anyway. Empty when every part is.
 */
export function composeFinal(...parts: Array<string | undefined>): string {
  const kept: string[] = [];
  for (const raw of parts) {
    const part = (raw ?? "").trim();
    if (!part) continue;
    const s = squash(part);
    if (kept.some((k) => squash(k).includes(s))) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (s.includes(squash(kept[i]))) kept.splice(i, 1);
    }
    kept.push(part);
  }
  return kept.join("\n\n");
}

/**
 * Tool arguments as they may be written to the log.
 *
 * `browser_type` types whatever it is handed, and what it is handed is
 * sometimes a password — the model filling in a login form the user asked it
 * to. Every other argument stays verbatim, because verbatim is what makes the
 * log diagnosable; this one is replaced by its length, which still tells a
 * flattened payload from an empty one.
 */
function loggableArguments(call: ToolCall): Record<string, unknown> {
  if (call.tool.toLowerCase().replace(/[-\s]/g, "_") !== "browser_type") return call.arguments;
  const text = call.arguments?.text;
  if (typeof text !== "string") return call.arguments;
  return { ...call.arguments, text: `<redacted ${text.length} chars>` };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Said back to a model that has just re-sent a call it already knows fails.
 *
 * Byte-identical arguments, byte-identical failure. The generic tool error is
 * already in the transcript and did not change anything, so this names the
 * loop itself and gives the tool's own way out.
 */
function repeatedCallAdvice(tool: string, attempts: number): string {
  const lead =
    `[OnFlip] That is attempt ${attempts} at this exact ${tool} call, with the same arguments, ` +
    "and it has failed identically every time. Sending it again will fail again.";

  if (tool === "edit" || tool === "multi_edit") {
    return [
      lead,
      "Change the call, not the intent: extend `old_string` with the lines above or below it until it is unique, or pass `replace_all: true` if every occurrence should change.",
      "If the file will not match at all, `read` it first — the copy you are editing from is out of date, and any line numbers in the error above tell you where to look.",
    ].join(" ");
  }
  if (tool === "bash") {
    return `${lead} Read the error output above and change the command, or find out why it fails before running it again.`;
  }
  return `${lead} Change the arguments, use a different tool, or tell the user what is blocking you.`;
}

/**
 * Does this text carry the instructions OnFlip sends, rather than a reply?
 *
 * Two independent markers, both of which ride on every payload and neither
 * of which a model would write unprompted.
 */
function looksLikeOwnPayload(text: string): boolean {
  const markers = [
    "[OnFlip protocol reminder]",
    "Never invent file contents, directory listings, or command output",
  ];
  return markers.some((m) => text.includes(m));
}

/** Replace typographic quotes with their ASCII equivalents. */
function straighten(text: string): string {
  // Uzbek's oʻ/gʻ are written with several different apostrophes; one form
  // is what the patterns below look for.
  return text.replace(/[‘’ʼʻ`´]/g, "'").replace(/[“”]/g, '"');
}

// ---------------------------------------------------------------------------
// wording hints
// ---------------------------------------------------------------------------
//
// None of what follows decides whether a turn is over — the closing blocks
// do that. These read a block-less reply only to pick the nudge that answers
// it: a model that says the tools are missing needs the roster, one asking
// for permission needs to hear that approval is OnFlip's job, one narrating
// output it never saw needs to be told the output is invented. A reply none
// of them recognise gets the plain nudge, which is enough.

/**
 * The same slips, in the languages OnFlip's own UI ships in.
 *
 * The model answers in the language it is written to, and Russian- and
 * Uzbek-speaking users are written to in Russian and Uzbek. Word boundaries
 * are ASCII-only in these patterns' engine, so Cyrillic is anchored on
 * neighbouring non-letters instead of `\b`. Uzbek is matched in Latin
 * script, which is what the model writes.
 */
const RU_DENIES_TOOLS =
  /(?:(?:не\s+могу|не\s+смогу|не\s+имею\s+возможности|невозможно|нет\s+возможности)[^.]{0,60}(?:инструмент|onflip|команд[уы]|выполнить|запустить|вызвать|редактировать|изменить\s+файл)|(?:инструмент\w*|onflip)[^.]{0,40}(?:недоступ|не\s+доступ|не\s+подключ|не\s+активн|отсутству|не\s+предоставлен|не\s+вижу)|нет\s+доступа\s+к[^.]{0,40}(?:инструмент|файл|машин|компьютер|систем)|в\s+этом\s+(?:чате|разговоре|сообщении|ходе|диалоге)[^.]{0,40}(?:не\s+могу|недоступ|нельзя))/i;
const UZ_DENIES_TOOLS =
  /(?:(?:vosita|asbob|onflip|buyruq)[^.]{0,50}(?:mavjud\s+emas|yo'q|ishlamaydi|ulanmagan|faol\s+emas|ko'rinmayapti)|(?:ishga\s+tushira\s+olmayman|bajara\s+olmayman|foydalana\s+olmayman|ishlata\s+olmayman|kirish\s+(?:huquqim|imkonim)\s+yo'q)|bu\s+(?:chat|suhbat|xabar)da[^.]{0,40}(?:olmayman|mumkin\s+emas|mavjud\s+emas))/i;

const RU_ASKS_PERMISSION =
  /(?:подтвердите|разрешите|разрешаете|одобрите|одобряете|можно\s+ли\s+(?:мне\s+)?(?:запустить|выполнить|изменить|удалить|создать|перезаписать)|могу\s+ли\s+я\s+(?:запустить|выполнить|изменить|удалить)|нужно\s+(?:ваше\s+)?(?:разрешение|подтверждение|одобрение)|жду\s+(?:вашего\s+)?(?:разрешения|подтверждения|одобрения)|дайте\s+(?:разрешение|добро))/i;
const UZ_ASKS_PERMISSION =
  /(?:ruxsat\s+ber|tasdiqla(?:ng|shingiz)|ruxsat\s+berasizmi|ruxsatingiz\s+kerak|tasdiqlashingiz\s+kerak|(?:ishga\s+tushir|bajar|o'zgartir|o'chir|yarat)[^.?]{0,30}mumkinmi|ruxsatingizni\s+kutaman)/i;

const RU_CLAIMS_EXECUTION =
  /(?:^|[^а-яё])я\s+(?:уже\s+)?(?:запустил|выполнил|прочитал|проверил|создал|обновил|собрал|установил|изменил|удалил|открыл|посмотрел|отредактировал|прогнал)(?:а)?(?=\s|[.,;:!?]|$)/i;
const UZ_CLAIMS_EXECUTION =
  /(?:ishga\s+tushirdim|bajardim|o'qidim|tekshirdim|yaratdim|yangiladim|o'rnatdim|o'zgartirdim|o'chirdim|ochdim|ko'rib\s+chiqdim|tuzatdim)/i;

/** Somewhere a tool of the *user's* lives: their machine, repo or manifest. */
const THEIR_PLACE =
  "(?:in|on|from|inside|within) (?:(?:your|the|this|that) )?(?:app|application|site|website|page|project|admin|dashboard|machine|computer|repo|repository|package\\.json|codebase|workspace)\\b";
const TOOL_THEN_PLACE = new RegExp(`\\btools?\\b[^.]{0,40}\\b${THEIR_PLACE}`, "i");
const PLACE_THEN_TOOL = new RegExp(`\\b${THEIR_PLACE}[^.]{0,60}\\btools?\\b`, "i");

function openTodoCount(todos: SessionState["todos"] | undefined): number {
  return (todos ?? []).filter((t) => t.status === "pending" || t.status === "in_progress").length;
}

/** The open task-list items, one line each, for a nudge to name. */
function openTodoLines(todos: SessionState["todos"] | undefined): string[] {
  return (todos ?? [])
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .slice(0, 8)
    .map((t) => `${t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`);
}

/**
 * Which nudge a block-less reply gets.
 *
 * Gated the way the detectors always were. Fabrication only applies while
 * nothing has actually run: once a tool has produced real output, "I ran
 * the build and it failed" is an accurate summary, not an invention.
 * Permission and denial stop once something has been refused: the denial
 * message itself tells the model to acknowledge it and ask how to proceed,
 * so correcting "since you declined, I can't run npm install" for doing
 * exactly that would be a contradiction. The hand-off is checked first: it
 * is the most certain of the slips and the only one the others cannot see,
 * since the card claims nothing and asks nothing.
 */
export function classifySlip(
  text: string,
  executedCalls: number,
  deniedCalls: number
): SlipVariant | null {
  if (detectWorkHandoff(text)) return "handoff";
  if (deniedCalls === 0 && detectToolDenial(text)) return "denial";
  if (deniedCalls === 0 && detectPermissionRequest(text)) return "permission";
  if (executedCalls === 0 && detectFabrication(text)) return "fabrication";
  if (looksCutOff(text)) return "cut";
  return null;
}

/**
 * The refusals a closing block can smuggle: a denial of the tools, a
 * request for permission, a hand-off. "Cut" and "fabrication" are left
 * out — a question may legitimately mention running things, and a summary
 * legitimately reports what ran.
 */
function pickRefusal(...variants: Array<SlipVariant | null>): SlipVariant | null {
  for (const v of variants) {
    if (v === "denial" || v === "permission" || v === "handoff") return v;
  }
  return null;
}

/**
 * A reply that stops mid-clause is a truncated stream, not an answer.
 *
 * Live: a paused generation was accepted seven characters in — "I'll re".
 * Two structural tells, neither about the verb: a fence opened and never
 * closed, and a very short reply that ends inside a promise with no
 * punctuation. ChatGPT's own truncation flag (`meta.truncated`) is handled
 * before any of this; this is for the transports that have no such flag.
 */
export function looksCutOff(raw: string): boolean {
  const original = raw.trim();
  if (!original) return false;
  // Fence parity is counted before `straighten`, and that ordering is the
  // whole check. `straighten` folds the backtick into an apostrophe — it is
  // one of the characters Uzbek writes oʻ/gʻ with — so counting fences on
  // the straightened text looked for a character that had just been removed.
  // The half of this function that catches a truncated code block had
  // therefore never fired once; only the short-promise rule below was live.
  // Found by a test, not in the field, which is the point of having one.
  const fenceLines = original.split("\n").filter((line) => /^\s*(`{3,}|~{3,})/.test(line)).length;
  if (fenceLines % 2 === 1) return true;
  const text = straighten(original);
  return (
    text.length < 100 &&
    /\b(i'?ll|i will|i'?m going to|let me)\s+\w{0,12}$/i.test(text) &&
    !/[.!?…)"']$/.test(text)
  );
}

/**
 * ChatGPT routing the task to its own agent product instead of answering.
 *
 * Live, on a coding request: the reply was a "Continue in ChatGPT Work"
 * card — a one-line summary of the task, then "Continuing…" and a button —
 * with no tool call and nothing done. Work runs on OpenAI's computers and
 * cannot see this one, so the hand-off is a refusal in a friendlier shape.
 * Matched on the card's own wording, which the model does not otherwise use.
 */
export function detectWorkHandoff(text: string): boolean {
  const t = straighten(text.trim());
  if (!t || t.length > 1200) return false;
  return (
    /\bcontinue in (chatgpt )?work\b/i.test(t) ||
    /\bcontinuing in (chatgpt )?work\b/i.test(t) ||
    /\b(open|opened|run|running|continue|continuing|hand(ed|ing)? (this |it )?(off )?to|moved? (this |it )?to) (in |into )?(chatgpt work|codex|agent mode)\b/i.test(t) ||
    /\bfix issues and run checks in work\b/i.test(t)
  );
}

/**
 * Is the model claiming it cannot reach the tools?
 *
 * It says this while sitting in a thread that was handed the whole tool
 * list, so it is a misreading of the protocol rather than a fact — and one
 * worth answering with the roster, because the alternative is a turn that
 * does nothing and a user who is told their agent has no tools.
 */
export function detectToolDenial(text: string): boolean {
  // ChatGPT renders apostrophes as U+2019, so a pattern written with the
  // typewriter apostrophe matches nothing it actually says.
  const t = straighten(text.trim());
  if (!t || t.length > 600) return false;
  // Talking about the *user's* tools — "the export tool in your app is not
  // accessible from the admin page", "I don't see a build tool in
  // package.json", "the gh CLI is not available on this machine, so I could
  // not use that tool" — is an answer about their code or their machine,
  // not a refusal about OnFlip's own tools. OnFlip denials say "in this
  // conversation/chat/turn", never "in your app" or "on this machine", so
  // a sentence that says both is still read as one.
  const aboutTheirs = TOOL_THEN_PLACE.test(t) || PLACE_THEN_TOOL.test(t);
  const aboutOurs =
    /\b(?:onflip|(?:this|the) (?:chat|conversation|turn|message|thread|context|session|runtime))\b/i.test(t);
  if (aboutTheirs && !aboutOurs) return false;
  return (
    /\b(do ?n'?t|cannot|can'?t|no|not) (have|see|access|reach|use)\b[^.]{0,40}\btools?\b/i.test(t) ||
    // "I'm sorry, but I can't execute the local file-editing tool in this
    // turn." Live, and missed by everything else here: the verb is `execute`,
    // it names one tool rather than the set, and it claims nothing about
    // availability — so the refusal went to the user as the answer to "update
    // the game name", with no correction and nothing run.
    /\b(cannot|can'?t|unable to|not able to|won'?t be able to)\b[^.]{0,60}\b(tools?|tool calls?|onflip blocks?)\b/i.test(t) ||
    // "I can't edit … from this chat", said without naming the tools at all.
    // "in this turn" belongs with it: the tools are attached to the
    // conversation, so no turn of it is one where they are missing.
    /\b(do ?n'?t|cannot|can'?t|unable to)\b[^.]{0,60}\b(from|in|within|during|on) (this|the) (chat|conversation|session|runtime|environment|turn|message|thread|context)\b/i.test(t) ||
    // "aren't *actually* exposed", "is not currently available" — the hedge
    // between the negation and the adjective is where these replies live.
    /\btools?\b[^.]{0,40}\b(aren'?t|are not|is not|isn'?t|not)( \w+){0,2} (available|exposed|attached|accessible|enabled)\b/i.test(t) ||
    /\bno (onflip )?tools? (are )?(available|exposed)\b/i.test(t) ||
    // "I don't have the ability to edit files here."
    /\b(do ?n'?t|does ?n'?t) have (the )?(ability|capability|permission|means)\b[^.]{0,60}\b(edit|writ|read|run|execut|modif|chang|creat|access|open|list|search)/i.test(t) ||
    // "the OnFlip tool runtime did not execute any machine-side calls in this
    // turn, so I have not modified the file." Live, and matched by nothing
    // above: the subject is the *runtime* rather than "I", and the verb is a
    // past-tense "did not execute" rather than a "cannot" — the model blaming
    // the harness for a call it never emitted, and ending the turn on it.
    // Naming OnFlip is damning on its own; a bare "runtime"/"harness" subject
    // only counts when the thing not executed is calls, blocks or tools —
    // "the cron harness did not execute the job" is a real answer about the
    // user's system, not an excuse.
    /\bonflip\b[^.]{0,50}\b(did ?n[o']?t|does ?n[o']?t|has ?n[o']?t|have ?n[o']?t|failed to|refused to)\b[^.]{0,40}\b(execute|run|process|perform|receive|pick up)\b/i.test(t) ||
    /\b(runtime|harness)\b[^.]{0,40}\b(did ?n[o']?t|does ?n[o']?t|has ?n[o']?t|have ?n[o']?t|failed to|refused to)\b[^.]{0,40}\b(execute|run|process|perform|receive|pick up)\b[^.]{0,40}\b(calls?|blocks?|tools?)\b/i.test(t) ||
    // "no machine-side calls were executed", "no tool calls went through".
    /\b(no|none of the|any)\b[^.]{0,30}\b(machine-side|tool|onflip)\b[^.]{0,20}\bcalls?\b[^.]{0,60}\b(executed|ran|made|performed|went through|reached)\b/i.test(t) ||
    // "the machine-side OnFlip execution channel is not actually exposed as
    // an invokable tool in this conversation" — live, straight after a
    // compaction opened a fresh thread. The subject is a *channel* and the
    // negation comes before the word "tool", so both earlier shapes missed
    // it and the excuse ended the turn with the plan at 1/5.
    /\b(onflip|machine-side|execution channel|tool channel)\b[^.]{0,60}\b(is|are)( \w+){0,2} not\b[^.]{0,60}\b(exposed|available|invokable|callable|attached|accessible|enabled)\b/i.test(t) ||
    /\bnot\b[^.]{0,40}\b(exposed|invokable|callable|available)\b[^.]{0,30}\btools?\b/i.test(t) ||
    // "I can't safely update the README without an actual machine-execution
    // tool available to this response." The negation is carried by
    // "without", so every pattern above — all of which look for a negated
    // verb or a negated adjective — walked straight past it. Anchored on a
    // "cannot" earlier in the same sentence so that advice about the
    // user's own system ("this will not run without a linter available")
    // is not swept up with it.
    /\b(cannot|can'?t|unable to|won'?t be able to)\b[^.]{0,80}\bwithout\b[^.]{0,60}\btools?\b/i.test(t) ||
    // "the required OnFlip execution channel is currently unavailable to me
    // in this turn" — the same subject as the clause above but with the
    // negation inside the adjective, where a search for "not" cannot see it.
    /\b(onflip|machine-side|execution channel|tool channel|execution interface|tool interface)\b[^.]{0,60}\b(is|are)( \w+){0,2} (unavailable|inaccessible|missing|absent)\b/i.test(t) ||
    // "The execution channel currently exposes only plugin-management
    // tools, not the OnFlip filesystem tools." Not a refusal in form at
    // all — a confident description of a tool namespace the model went
    // looking for and did not find, which ends the turn just as dead.
    /\bnot\b[^.]{0,40}\bthe onflip\b[^.]{0,30}\btools?\b/i.test(t) ||
    RU_DENIES_TOOLS.test(t) ||
    UZ_DENIES_TOOLS.test(t)
  );
}

/**
 * The browser transport already refuses to accept one of these as a reply, so
 * by the time the loop sees one it came through a path that does not — the API
 * transport, or a message too long for the transport's own check. Still worth
 * attributing rather than rendering as the agent's answer.
 */
function detectServiceMessage(text: string): string | null {
  return serviceMessage(text);
}

/**
 * "confirm" followed by something that can be done, rather than something
 * that can merely be true: the call, the go-ahead, "that I should", "and
 * I'll". A bare "that …" is left out on purpose — "confirm that the path is
 * right" is a question about a fact.
 */
const ASKS_TO_CONFIRM_ACTION = new RegExp(
  "\\b(?:please|kindly|do you|can you|could you|will you) confirm,?\\s+(?:" +
    "this|it" +
    "|(?:the|this|that|these|those|each|all)(?: \\w+){0,2} (?:commands?|calls?|actions?|changes?|edits?|runs?|steps?|operations?|deletions?|writes?|installs?|installation|removal|execution|invocation|requests?|plan)" +
    "|(?:that )?(?:i|you want me to|you'?d like me to)" +
    "|(?:whether|if) (?:i|you)" +
    "|(?:so|and|before) (?:that )?i" +
    "|(?:to )?(?:proceed|continue|go ahead)" +
    ")\\b",
  "i"
);

/**
 * The model asking for permission instead of calling the tool.
 *
 * OnFlip owns approval, so a request for it is a dead end: nothing runs, the
 * turn ends, and the user is left staring at a question they already answered
 * by asking in the first place. The signature is narrow on purpose — an
 * ordinary clarifying question ("which of these did you mean?") must survive,
 * and now has a block of its own (`ask_user`) that never comes through here.
 */
export function detectPermissionRequest(raw: string): boolean {
  const text = straighten(raw).trim();
  if (!text) return false;
  // A permission stall is short — it is a question, not a report. A long
  // final answer that happens to contain "confirm" near "run" is an answer,
  // and correcting it costs a full round trip. Live: an audit report saying
  // "to confirm the fix, run the build" was rejected as a permission slip.
  if (text.length > 600) return false;
  // "What would you like me to check?" is a genuine scoping question — one
  // of the legitimate ways to end a turn — where "Would you like me to check
  // X?" is a yes/no stall about work the model should simply do. The
  // question word is the difference; forcing a retry on the former makes the
  // model guess at scope instead of asking.
  if (/\b(what|which|where|when|how (much|many))\b[^.?!]{0,30}\bwould you like me to\b/i.test(text)) {
    return false;
  }

  // Asking the user to approve: a request aimed at them, not the mere
  // co-occurrence of "confirm" and "run" somewhere in the reply — which is
  // what this used to match, and most working replies contain both.
  const asksToRun =
    /\b(please|kindly) (approve|grant)\b/i.test(text) ||
    /\b(do you|can you|could you|will you) (approve|grant)\b/i.test(text) ||
    // "Could you confirm the file path?" is a clarifying question; "could
    // you confirm this / that I should run it / and I'll proceed" is a
    // stall. What is being confirmed has to be an action or the go-ahead.
    ASKS_TO_CONFIRM_ACTION.test(text) ||
    /\b(approval|permission|confirmation)\b[^.?!]{0,40}\b(before|so|and) i\b/i.test(text) ||
    /\bwait(ing)? for (your )?(approval|permission|confirmation|go-?ahead)\b/i.test(text) ||
    // Only when the model is the one who needs it. "The PR needs approval
    // from a code owner" is a report about the user's repository.
    /\b(?:i|i'?ll|i'?d|i'?m|i will|i would)\b[^.?!]{0,30}\bneeds? (your )?(approval|permission|confirmation)\b/i.test(text) ||
    /\bapprove (this|it|that|the (command|call|action))\b/i.test(text);
  const offersToRun =
    /\b(shall|should) i (run|execute|check|inspect)\b/i.test(text) ||
    /\b(let me know if|tell me if) you('d| would) like me to\b/i.test(text) ||
    /\bwould you like me to (run|execute|check|inspect)\b/i.test(text) ||
    /\bi (can|could) (run|check|inspect)\b[^.]*\bbut\b/i.test(text);

  return asksToRun || offersToRun || RU_ASKS_PERMISSION.test(text) || UZ_ASKS_PERMISSION.test(text);
}

/**
 * Something the verb acted on: "the build", "`npm test`", a path, a file name,
 * a command. Without one, "I read the trace as a null dereference" and "I run
 * into this a lot" both counted as claims of execution.
 */
const EXECUTION_TARGET =
  "(?:" +
  "(?:the|a|an|this|that|these|those|your|my|our|its|each|every|both|all)\\b(?: \\S+){0,2} (?:files?|commands?|scripts?|tests?|suite|build|output|logs?|director(?:y|ies)|folders?|repo|repository|codebase|packages?|dependencies|contents?|results?|diff|changes?)\\b" +
  "|`" +
  "|(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|~[\\\\/]|/)\\S+" +
  "|\\S+[\\\\/]\\S+" +
  "|[\\w-]+\\.[A-Za-z]{1,6}\\b" +
  "|(?:npm|npx|yarn|pnpm|node|git|python|pip|cargo|go|dotnet|make|tsc|pytest|jest|ls|dir|cat|grep|rg)\\b" +
  ")";
// "I ran", "I've run", "I have run", "I just ran", "I've just run". The old
// form wrote the contraction as a separate token — `i 've` — and so could
// never match the way it is actually written.
const CLAIMS_EXECUTION = new RegExp(
  "\\bi(?:'ve| have)?(?: just)? (?:ran|run|executed|checked|opened|listed|searched|read|created|wrote|edited|installed|inspected)\\b(?::\\s*|\\s+)" +
    EXECUTION_TARGET,
  "i"
);

/**
 * The characteristic failure of driving a chat model as an agent: it
 * narrates having run something instead of emitting a tool call, then
 * reports output it invented. Only strong signals fire — the nudge it
 * selects says the output is invented, which must not be said of a real
 * answer.
 */
export function detectFabrication(raw: string): boolean {
  const text = straighten(raw);
  if (!text.trim()) return false;

  return (
    CLAIMS_EXECUTION.test(text) ||
    /\b(?:running|executing) the (?:command|test|build)\b/i.test(text) ||
    RU_CLAIMS_EXECUTION.test(text) ||
    UZ_CLAIMS_EXECUTION.test(text)
  );
}

/**
 * Replace the transcript with a summary of itself.
 *
 * The system prompt survives verbatim; everything after it collapses into one
 * handover brief. The transport is reset so the next send opens a clean thread
 * rather than appending to one whose beginning the model can no longer see.
 *
 * Returns the messages that actually left the transcript, which is what the
 * caller archives — not "everything but the system prompt", which on a failed
 * summary archived the kept tail while it was still live, and the desktop
 * showed those messages twice.
 */
/**
 * The most recent thing the user actually typed, or null.
 *
 * Not every `user` message is the user: tool results and protocol nudges ride
 * the same role. Those are recognisable — a result carries `toolName` and
 * opens with `<onflip:result`, and everything OnFlip writes itself opens with
 * a bracketed tag.
 */
export function lastUserRequest(history: ChatMessage[], limit = 2_000): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (!isUserRequest(message)) continue;
    const text = message.content.trim();
    if (!text) continue;
    return text.length > limit ? `${text.slice(0, limit)}\n\n… (request truncated)` : text;
  }
  return null;
}

async function compact(history: ChatMessage[], opts: AgentOptions): Promise<ChatMessage[]> {
  const systemMessage = history[0]?.role === "system" ? history[0] : null;
  // Kept before the transcript is replaced. A brief is the model's paraphrase
  // of the request, written in whatever language the session had drifted into
  // — and after compaction it is the only version of the request left, so the
  // paraphrase becomes the request. Live, a session working in English on a
  // Russian-locale machine compacted, and every reply after that point came
  // back in Russian: the user's own words were gone and the Russian
  // PowerShell errors in the tool output were all that was left to imitate.
  const asked = lastUserRequest(history);

  // A summary is only worth having if it leaves room to work: a fifth of the
  // budget, so a compacted session can take several more turns before it
  // needs compacting again. Without this the brief filled the budget by
  // itself and every tool call started another round.
  const budget = opts.compactAfterChars ?? 28_000;
  const target = Math.max(2_000, Math.floor(budget * 0.2));

  let summary = "";
  try {
    const reply = await opts.transport.send(
      [...history, newMessage("user", compactInstruction(target))],
      { model: opts.model, thinking: "low", signal: opts.signal }
    );
    // The brief is asked for as prose, but a model that has been closing
    // every reply with a `done` block may close this one too — and its
    // summary argument is the brief.
    const parsed = parseTurn(reply.content, toolKnownTo(opts.tools));
    const closing = parsed.calls.find((c) => terminalNameOf(opts.tools, c.tool) === "done");
    summary = (closing ? stringArgument(closing.arguments.summary) : "").trim() || parsed.text.trim();
  } catch {
    // Summarising is best-effort; losing the session would be worse.
  }

  // Esc while the summary was being written: the browser client throws on
  // abort and the catch above swallows it, so this used to carry on with an
  // empty summary — reset the transport and cut the transcript to its tail.
  // An interrupt that quietly lost the conversation. Nothing has been touched
  // yet, so leaving now leaves everything as it was.
  if (opts.signal?.aborted) return [];

  // Asked for a limit and given more anyway: keep the head, which is where a
  // handover brief puts the request and the state, and say it was cut.
  if (summary.length > target * 1.5) {
    logger.warn("agent", "the summary ignored its length limit", {
      chars: summary.length,
      target,
    });
    summary = `${summary.slice(0, target)}

… the rest of this brief was cut to fit the context budget …`;
  }

  opts.transport.reset();
  // The system message goes back on its own below; a short transcript used
  // to keep it in the tail as well and push it twice.
  const rest = history.filter((m) => m.role !== "system");
  const tail = rest.slice(-8);
  history.length = 0;
  if (systemMessage) history.push(systemMessage);

  if (summary) {
    history.push(
      newMessage(
        "user",
        [
          "[Context carried over from the earlier part of this session]",
          "",
          summary,
          ...(asked
            ? [
                "",
                "The request being worked on, in the user's own words:",
                "",
                asked,
                "",
                "Answer in the language of that request, whatever language the notes above happen to be in.",
              ]
            : []),
          "",
          "Continue from here. The tool protocol and every instruction above still applies.",
        ].join("\n")
      )
    );
    return rest;
  }
  // No summary — keep the most recent exchanges verbatim instead.
  history.push(...tail);
  return rest.slice(0, rest.length - tail.length);
}

/** Explicit compaction, exposed to the /compact command. */
export async function compactNow(
  history: ChatMessage[],
  opts: AgentOptions
): Promise<void> {
  const dropped = await compact(history, opts);
  if (dropped.length) opts.events?.onCompacted?.(dropped);
}
