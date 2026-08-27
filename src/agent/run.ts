import { ChatMessage, ToolCall, ToolResult, SessionState } from "../types";
import { ToolRegistry } from "../tools";
import { Transport, SendOptions } from "../chatgpt/transport";
import { newMessage, parseTurn, formatToolResult } from "./protocol";
import { turnReminder, protocolCorrection, COMPACT_INSTRUCTION } from "./system";
import { logger } from "../log";
import {
  classifyFailure,
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
 * tool calls it asked for. The loop ends when the model answers with prose and
 * no tool call, when the step budget runs out, or when the user interrupts.
 */

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
  /** The model's final prose answer. */
  onFinal?(text: string): void;
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

export interface AgentTurnResult {
  finalAnswer: string;
  iterations: number;
  /** True when the loop stopped because the step budget ran out. */
  exhausted: boolean;
  interrupted: boolean;
}

const MAX_TRANSPORT_RETRIES = 2;
const MAX_PROTOCOL_CORRECTIONS = 2;

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
  let protocolCorrections = 0;
  /** Tool calls actually executed this turn; gates fabrication detection. */
  let executedCalls = 0;
  /** Tool calls the policy refused this turn; gates permission-slip detection. */
  let deniedCalls = 0;
  /** Identical calls that have already failed, so a repeat can be named as one. */
  const failedCalls = new Map<string, number>();

  // A non-numeric budget would make `iteration <= budget` false on the first
  // comparison, so the loop would fall straight through and report a turn that
  // never happened. Refuse to run on a nonsense value rather than no-op.
  const budget = Number(opts.maxIterations);
  if (!Number.isFinite(budget) || budget < 1) {
    throw new Error(
      `Invalid step budget (${String(opts.maxIterations)}). Set a positive number with: onflip config maxIterations 40`
    );
  }

  // Set when a compaction failed to shrink anything, so a transcript that is
  // over budget for some other reason cannot put the turn in a loop.
  let compactionExhausted = false;

  for (let iteration = 1; iteration <= budget; iteration++) {
    if (opts.signal.aborted) {
      return { finalAnswer: "", iterations: iteration - 1, exhausted: false, interrupted: true };
    }

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

    let reply: string;
    try {
      reply = await sendWithRetry(history, opts, events);
    } catch (e) {
      if (opts.signal.aborted) {
        return { finalAnswer: "", iterations: iteration, exhausted: false, interrupted: true };
      }
      throw e;
    }

    history.push(newMessage("assistant", reply));

    let { text, calls, malformed } = parseTurn(reply);

    // A reply carrying our own instructions is the page handing back what
    // we sent. Its 'tool calls' are the worked examples out of the prompt,
    // and running them writes files nobody asked for.
    if (calls.length > 0 && looksLikeOwnPayload(reply)) {
      logger.warn("protocol", "reply contained our own prompt", {
        chars: reply.length,
        calls: calls.map((c) => c.tool),
      });
      calls = [];
      malformed =
        "the reply came back containing OnFlip's own instructions rather than an answer.";
    }
    logger.info("agent", `iteration ${iteration} parsed`, {
      calls: calls.map((c) => c.tool),
      proseChars: text.length,
      malformed: malformed ?? null,
    });

    // ---- no tool calls: the final answer, or a protocol slip ---------------
    if (calls.length === 0) {
      // A call that was attempted but did not parse must never be shown to the
      // user as an answer — that is how a broken JSON blob ends up on screen
      // instead of the disk usage they asked for.
      if (malformed && protocolCorrections < MAX_PROTOCOL_CORRECTIONS) {
        // The raw reply is the only thing that explains a parse failure, so it
        // is recorded at warn level rather than debug — a normal run that goes
        // wrong must leave enough behind to diagnose without reproducing it.
        logger.warn("protocol", "reply did not parse", { reason: malformed, reply });
        protocolCorrections++;
        events.onNotice?.(`Malformed tool call — ${malformed} Asking for a retry.`);
        history.push(newMessage("user", protocolCorrection(malformed)));
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

      // Fabrication detection only applies while nothing has actually run.
      // Once a tool has produced real output, "I ran the build and it failed"
      // is an accurate summary, not an invention — flagging it there would
      // reject the model's closing answer on almost every successful turn.
      //
      // Permission-slip detection stops once something has been refused: the
      // denial message itself tells the model to acknowledge it and ask how to
      // proceed, so correcting it for doing exactly that is a contradiction —
      // and an expensive one, since each correction costs a round trip.
      const slip =
        detectToolDenial(text) ??
        (deniedCalls === 0 ? detectPermissionRequest(text) : null) ??
        (executedCalls === 0 ? detectFabrication(text) : null) ??
        // Held back after a denial for the same reason as the permission
        // check: "I'll wait to hear how you want to proceed" is the correct
        // way to end a turn that was refused, not a slip.
        (deniedCalls === 0 ? detectAbandonedTurn(text) : null);
      if (slip && protocolCorrections < MAX_PROTOCOL_CORRECTIONS) {
        protocolCorrections++;
        events.onNotice?.(`Protocol slip — ${slip}. Asking for a retry.`);
        history.push(newMessage("user", protocolCorrection(slip)));
        continue;
      }
      // Corrections are spent and it still will not call a tool. Saying so
      // is worth more than the refusal itself: the protocol is text a model
      // has to be willing to follow, and the lighter tiers frequently are
      // not — which reads to the user as "the app has no tools" when the
      // tools were there and listed all along.
      if (slip) {
        logger.warn("agent", "model refused the tool protocol", {
          model: opts.model,
          corrections: protocolCorrections,
        });
        events.onNotice?.(
          `This model answered in prose and would not emit a tool call, even after ${protocolCorrections} corrections — so nothing was run. ` +
            "That is the model declining the protocol, not a missing tool. Switch model with the chip under the composer (the lighter tiers often refuse it) and send again."
        );
      }
      // ChatGPT's own service messages come back through the same channel as a
      // reply and read like the agent's answer. Saying whose message it is
      // saves the user debugging OnFlip for something OnFlip did not do.
      const service = detectServiceMessage(text);
      if (service) {
        logger.warn("agent", "chatgpt service message", { text: text.trim().slice(0, 300) });
        events.onNotice?.(service);
      }
      events.onFinal?.(text);
      return { finalAnswer: text, iterations: iteration, exhausted: false, interrupted: false };
    }

    protocolCorrections = 0;
    if (text.trim()) events.onNarration?.(text.trim());

    // ---- execute the requested tools ---------------------------------------
    const resultBlocks: string[] = [];
    for (const call of calls) {
      if (opts.signal.aborted) {
        // Keep whatever already ran so the transcript stays truthful.
        if (resultBlocks.length) {
          history.push(newMessage("user", resultBlocks.join("\n\n")));
        }
        return { finalAnswer: "", iterations: iteration, exhausted: false, interrupted: true };
      }

      events.onToolStart?.(call);
      logger.info("tool", `run ${call.tool}`, { args: call.arguments });
      const startedAt = Date.now();
      const result = await opts.tools.run(call.tool, call.arguments);
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

    history.push(
      newMessage("user", resultBlocks.join("\n\n"), { toolName: calls[0].tool })
    );
  }

  return { finalAnswer: "", iterations: budget, exhausted: true, interrupted: false };
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

/** Why this transcript should be compacted, or null to leave it alone. */
export function compactionReason(
  history: ChatMessage[],
  limits: { compactAfterChars?: number; compactAfterMessages?: number }
): string | null {
  const chars = transcriptChars(history);
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
  await compact(history, opts);

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
  return "compacted";
}

async function sendWithRetry(
  history: ChatMessage[],
  opts: AgentOptions,
  events: AgentEvents
): Promise<string> {
  const sendOptions: SendOptions = {
    model: opts.model,
    thinking: opts.thinking,
    signal: opts.signal,
    onDelta: events.onDelta,
    reminder: turnReminder(opts.shellEnabled, opts.tools.list.map((t) => t.name)),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
    try {
      const reply = await opts.transport.send(history, sendOptions);
      if (reply.content.trim()) {
        // A reply that lands is the only proof the block has lifted.
        clearCooldown();
        return reply.content;
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
      const failure = classifyFailure(message);
      if (failure.kind === "cooldown") {
        startCooldown(failure.seconds, failure.reason);
        events.onNotice?.(
          `${failure.reason} Pausing for ${describeWait(failure.seconds * 1000)} — retrying now would extend it.`
        );
        throw e;
      }
      if (failure.kind === "fatal") throw e;
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
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
 * Catch the characteristic failure of driving a chat model as an agent: it
 * narrates having run something instead of emitting a tool call, then reports
 * output it invented. Only strong signals fire — a false positive costs the
 * user a wasted round trip.
 */
/**
 * The model asking for permission instead of calling the tool.
 *
 * OnFlip owns approval, so a request for it is a dead end: nothing runs, the
 * turn ends, and the user is left staring at a question they already answered
 * by asking in the first place. The signature is narrow on purpose — an
 * ordinary clarifying question ("which of these did you mean?") must survive.
 */
/**
 * Is this ChatGPT talking, rather than the model answering?
 *
 * Image moderation, rate limits and internal errors all arrive as ordinary
 * assistant text, so they get rendered as the agent's answer — and the user
 * goes looking for the bug in OnFlip. Gated on a short reply, because a long
 * answer that happens to quote one of these phrases is discussing it, not
 * being it.
 */
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
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/**
 * Is the model claiming it cannot reach the tools?
 *
 * It says this while sitting in a thread that was handed the whole tool
 * list, so it is a misreading of the protocol rather than a fact — and one
 * worth correcting, because the alternative is a turn that does nothing and
 * a user who is told their agent has no tools.
 */
function detectToolDenial(text: string): string | null {
  // ChatGPT renders apostrophes as U+2019, so a pattern written with the
  // typewriter apostrophe matches nothing it actually says.
  const t = straighten(text.trim());
  if (!t || t.length > 600) return null;
  // Talking about the *user's* tools — "the export tool in your app is not
  // accessible from the admin page" — is an answer about their code, not a
  // refusal about OnFlip's own tools. OnFlip denials say "in this
  // conversation/chat/turn", never "in your app".
  if (/\btools?\b[^.]{0,30}\bin (your|the|this) (app|application|site|website|page|project|admin|dashboard)\b/i.test(t)) {
    return null;
  }
  const denies =
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
    /\bnot\b[^.]{0,40}\b(exposed|invokable|callable|available)\b[^.]{0,30}\btools?\b/i.test(t);
  if (!denies) return null;
  return (
    "you said a tool could not run, or that OnFlip executed nothing — but " +
    "OnFlip runs every onflip block you emit, and this reply contained none. " +
    "The tools are attached to this conversation and callable on every turn " +
    "of it, this one included — emit the onflip block now instead of " +
    "describing what did not happen"
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

function detectPermissionRequest(raw: string): string | null {
  const text = straighten(raw);
  if (!text.trim()) return null;

  const asksToRun =
    /\b(approve|approval|permission|confirm)\b/i.test(text) &&
    /\b(run|execute|command|powershell|shell|check|inspect)\b/i.test(text);
  const offersToRun =
    /\b(shall|should) i (run|execute|check|inspect)\b/i.test(text) ||
    /\b(let me know if|tell me if) you('d| would) like me to\b/i.test(text) ||
    /\bwould you like me to (run|execute|check|inspect)\b/i.test(text) ||
    /\bi (can|could) (run|check|inspect)\b[^.]*\bbut\b/i.test(text);

  if (asksToRun || offersToRun) {
    return "you asked the user for permission instead of emitting the tool call — OnFlip handles approval itself, so nothing ran and the turn ended";
  }
  return null;
}

/**
 * The model announcing its next move instead of making it.
 *
 * A turn ends the moment a reply carries no tool call, so "I'll restore the
 * file and rebuild" is not a plan — it is the session stopping with the work
 * half done, and the user typing "continue" to do by hand what the loop should
 * have done itself.
 *
 * Neither of the other detectors sees it. Nothing false was claimed, so it is
 * not fabrication; nothing was asked for, so it is not a permission slip. And
 * it happens *after* tools have run, which is precisely where fabrication
 * detection stops looking.
 */
function detectAbandonedTurn(raw: string): string | null {
  const text = straighten(raw).trim();
  // A closing report may reasonably mention what happens next. This is aimed
  // at the one-line "here is what I am about to do" that ends a working turn.
  if (!text || text.length > 400) return null;

  // Handing the work back is a legitimate way to finish.
  if (/\bi'?ll (leave|let you|let the|need you|wait|stop|hold|defer)\b/i.test(text)) return null;
  if (/\byou'?ll need to\b|\bover to you\b/i.test(text)) return null;

  // A reply that stops mid-clause is a truncated stream, not an answer.
  // Live: a paused generation was accepted seven characters in — "I'll re" —
  // and no verb-based pattern can see a verb that never finished arriving.
  if (
    text.length < 100 &&
    /\b(i'?ll|i will|i'?m going to|let me)\s+\w{0,12}$/i.test(text) &&
    !/[.!?…)"']$/.test(text)
  ) {
    return (
      "your reply appears to be cut off mid-sentence — send the complete reply, " +
      "continuing from where it stopped, with the tool call included"
    );
  }

  const announcesNextStep =
    /\b(i'?ll|i will|i'?m going to|i am going to|let me|next,? i'?ll)\b[^.]{0,40}\b(restore|rebuild|re-?read|read|run|fix|patch|apply|edit|update|write|create|add|remove|delete|check|verify|inspect|search|look|build|test|install|revert|continue|implement|refactor|rename|move|open|list|grep|start|try)\b/i;
  if (!announcesNextStep.test(text)) return null;

  return (
    "you ended the turn by saying what you would do next instead of doing it — " +
    "a reply with no tool call *is* the end of the turn, so emit the call now rather than describing it"
  );
}

function detectFabrication(raw: string): string | null {
  const text = straighten(raw);
  if (!text.trim()) return "the reply was empty";

  const claimsExecution =
    /\bi (?:just |have |'ve )?(?:ran|run|executed|checked|opened|listed|searched|read|created|wrote|edited|installed|inspected)\b/i.test(
      text
    ) || /\b(?:running|executing) the (?:command|test|build)\b/i.test(text);

  // Content only obtainable by actually running something.
  const showsOutput =
    /```[\s\S]*?```/.test(text) ||
    /^\s*(?:total \d+|drwx|-rw-|\$ |PS [A-Z]:\\)/m.test(text) ||
    /\b(?:PASS|FAIL|\d+ passing|\d+ failing|exit code \d+)\b/.test(text);

  if (claimsExecution && showsOutput) {
    return "you described running something and showed its output, but emitted no tool call — that output is invented";
  }
  if (claimsExecution) {
    return "you said you ran or read something, but emitted no tool call";
  }
  return null;
}

/**
 * Replace the transcript with a summary of itself.
 *
 * The system prompt survives verbatim; everything after it collapses into one
 * handover brief. The transport is reset so the next send opens a clean thread
 * rather than appending to one whose beginning the model can no longer see.
 */
async function compact(history: ChatMessage[], opts: AgentOptions): Promise<void> {
  const systemMessage = history[0]?.role === "system" ? history[0] : null;

  let summary = "";
  try {
    const reply = await opts.transport.send(
      [...history, newMessage("user", COMPACT_INSTRUCTION)],
      { model: opts.model, thinking: "low", signal: opts.signal }
    );
    summary = parseTurn(reply.content).text.trim();
  } catch {
    // Summarising is best-effort; losing the session would be worse.
  }

  opts.transport.reset();
  const tail = history.slice(-8);
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
          "",
          "Continue from here. The tool protocol and every instruction above still applies.",
        ].join("\n")
      )
    );
  } else {
    // No summary — keep the most recent exchanges verbatim instead.
    history.push(...tail);
  }
}

/** Explicit compaction, exposed to the /compact command. */
export async function compactNow(
  history: ChatMessage[],
  opts: AgentOptions
): Promise<void> {
  await compact(history, opts);
}
