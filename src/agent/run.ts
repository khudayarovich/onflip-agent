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

  // A non-numeric budget would make `iteration <= budget` false on the first
  // comparison, so the loop would fall straight through and report a turn that
  // never happened. Refuse to run on a nonsense value rather than no-op.
  const budget = Number(opts.maxIterations);
  if (!Number.isFinite(budget) || budget < 1) {
    throw new Error(
      `Invalid step budget (${String(opts.maxIterations)}). Set a positive number with: onflip config maxIterations 40`
    );
  }

  if (opts.compactAfterMessages && history.length > opts.compactAfterMessages) {
    events.onNotice?.("Context is getting long — compacting.");
    await compact(history, opts);
  }

  for (let iteration = 1; iteration <= budget; iteration++) {
    if (opts.signal.aborted) {
      return { finalAnswer: "", iterations: iteration - 1, exhausted: false, interrupted: true };
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
        (executedCalls === 0 ? detectFabrication(text) : null);
      if (slip && protocolCorrections < MAX_PROTOCOL_CORRECTIONS) {
        protocolCorrections++;
        events.onNotice?.(`Protocol slip — ${slip}. Asking for a retry.`);
        history.push(newMessage("user", protocolCorrection(slip)));
        continue;
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

      resultBlocks.push(formatToolResult(call, result.output, Boolean(result.error)));
    }

    history.push(
      newMessage("user", resultBlocks.join("\n\n"), { toolName: calls[0].tool })
    );
  }

  return { finalAnswer: "", iterations: budget, exhausted: true, interrupted: false };
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
    /\b(do ?n'?t|does ?n'?t) have (the )?(ability|capability|permission|means)\b[^.]{0,60}\b(edit|writ|read|run|execut|modif|chang|creat|access|open|list|search)/i.test(t);
  if (!denies) return null;
  return (
    "you said you could not run a tool, but the tools are attached to this " +
    "conversation and callable on every turn of it, this one included — emit " +
    "an onflip block instead of describing what you cannot do"
  );
}

function detectServiceMessage(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 400) return null;

  if (/image we created may violate|content polic/i.test(t)) {
    return "That message came from ChatGPT's image moderation, not from OnFlip — the picture was generated and then blocked. Rewording the prompt usually clears it; brand and game names are a common trigger. OnFlip has no image tool, so a generated image stays in the web chat rather than being saved to your project.";
  }
  if (/you'?ve (reached|hit) (your|the) .{0,30}(limit|cap)|rate limit|usage limit/i.test(t)) {
    return "ChatGPT is rate-limiting this account, so that was its message rather than an answer. Waiting, or switching model with /model, is what clears it.";
  }
  if (/^(something went wrong|an error occurred|there was an error)\b/i.test(t)) {
    return "ChatGPT returned an error page instead of a reply. Try the turn again; if it keeps happening, `onflip login --headed` shows what the page is doing.";
  }
  return null;
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
