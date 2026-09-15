import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Approval policy for side-effecting tools.
 *
 * The agent is driven by a remote model over a web session, so every write and
 * every shell command is treated as untrusted until the policy (or the user)
 * clears it. Modes mirror the ones coding CLIs converged on.
 */
export type ApprovalMode =
  /** Nothing mutates: reads and searches only. Good for planning. */
  | "read-only"
  /** Ask before any write and any command. The default. */
  | "ask"
  /** File edits inside the workspace go through; commands still ask. */
  | "auto-edit"
  /** Everything runs unattended except commands flagged destructive. */
  | "full-auto"
  /** Everything runs, including destructive commands. Opt-in only. */
  | "yolo";

export const APPROVAL_MODES: ApprovalMode[] = [
  "read-only",
  "ask",
  "auto-edit",
  "full-auto",
  "yolo",
];

/**
 * User-facing descriptions, for CLI help and the picker. The implied subject
 * is OnFlip: "ask" means *OnFlip* asks.
 */
export const APPROVAL_DESCRIPTIONS: Record<ApprovalMode, string> = {
  "read-only": "reads only — no writes, no commands",
  ask: "ask before every write and command",
  "auto-edit": "auto-approve workspace edits, ask for commands",
  "full-auto": "auto-approve everything except destructive commands",
  yolo: "auto-approve everything, including destructive commands",
};

/**
 * Model-facing descriptions.
 *
 * Deliberately separate from the strings above. Reusing those in the system
 * prompt reads as an instruction to the model — "ask before every write and
 * command" — and it complies, replying "approve this and I'll run it" instead
 * of emitting the call. The subject has to be unmistakably OnFlip.
 */
export const APPROVAL_MODEL_GUIDANCE: Record<ApprovalMode, string> = {
  "read-only":
    "OnFlip will refuse writes and commands outright. Only reading and searching will succeed.",
  ask: "OnFlip will pause and ask the user to confirm each write and each command before it runs.",
  "auto-edit":
    "OnFlip runs edits inside the workspace without asking, and pauses for the user's confirmation on commands.",
  "full-auto":
    "OnFlip runs everything without asking, except commands it flags as destructive.",
  yolo: "OnFlip runs everything without asking.",
};

export function isApprovalMode(v: string): v is ApprovalMode {
  return (APPROVAL_MODES as string[]).includes(v);
}

/**
 * The modes that run without a person, and are therefore not offered on macOS.
 *
 * `full-auto` and `yolo` remove the last human check: the model's output goes
 * straight to the shell, and what stands between it and the machine is a list
 * of regular expressions. That list cannot see through an interpreter, a
 * package manager, `find -exec`, an alias, or code the model just downloaded
 * — and an external audit demonstrated exactly that against the shipped
 * build, on a Mac left in `full-auto`.
 *
 * Disabled on macOS at the owner's request, after that audit. The honest
 * caveat, stated here rather than left to be discovered: the risk is not
 * macOS-specific. It is the same mode with the same reach on every platform.
 * What is specific is that this is the machine running unattended from a
 * phone, so it is the machine where nobody is watching the screen when a
 * command runs.
 *
 * `ONFLIP_ALLOW_FULL_ACCESS=1` puts them back, because a guard with no way
 * past it is a guard people work around by worse means. Setting an
 * environment variable is a deliberate act; clicking a menu entry is not.
 */
const UNATTENDED_MODES: ApprovalMode[] = ["full-auto", "yolo"];

export function unattendedAllowed(
  platform: string = process.platform,
  override: string | undefined = process.env.ONFLIP_ALLOW_FULL_ACCESS
): boolean {
  if (override === "1") return true;
  return platform !== "darwin";
}

/** The modes this machine may actually be put into. */
export function availableModes(
  platform: string = process.platform,
  override: string | undefined = process.env.ONFLIP_ALLOW_FULL_ACCESS
): ApprovalMode[] {
  if (unattendedAllowed(platform, override)) return [...APPROVAL_MODES];
  return APPROVAL_MODES.filter((m) => !UNATTENDED_MODES.includes(m));
}

/**
 * The mode this machine will honour, given the one that was asked for.
 *
 * Applied both to what is read from the config and to what is set later, so
 * a value stored by another machine — or by a build before this rule — cannot
 * put a Mac back into full access without anyone choosing it.
 */
export function clampApprovalMode(
  mode: ApprovalMode,
  platform: string = process.platform,
  override: string | undefined = process.env.ONFLIP_ALLOW_FULL_ACCESS
): ApprovalMode {
  if (unattendedAllowed(platform, override)) return mode;
  return UNATTENDED_MODES.includes(mode) ? "ask" : mode;
}

export type PermissionKind = "read" | "write" | "command" | "network";

export interface PermissionRequest {
  kind: PermissionKind;
  /** Tool that triggered the request. */
  tool: string;
  /** Human-readable one-line summary, e.g. the command or file path. */
  subject: string;
  /** Absolute path being written, when kind is "write". */
  targetPath?: string;
  /** Extra detail shown in the prompt (diff preview, full command). */
  detail?: string[];
}

export type PermissionDecision =
  | { allow: true; remember?: boolean; reason?: string }
  | { allow: false; reason: string };

/**
 * Commands that can destroy data, exfiltrate the workspace, or take the machine
 * down. These always prompt unless the mode is explicitly `yolo`.
 */
const DESTRUCTIVE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, why: "recursive/forced delete" },
  { re: /\brm\b[^|;\n]*\s--(recursive|force)\b/, why: "recursive/forced delete" },
  { re: /\b(rd|rmdir)\b(\s+\/[a-z])*\s+\/s\b/i, why: "recursive directory delete" },
  { re: /\bdel\s+.*\/[sfq]/i, why: "forced delete" },
  // PowerShell spells delete five ways and lets a parameter be any unambiguous
  // prefix of its name, so `ri -Rec -Fo` is the same call as
  // `Remove-Item -Recurse -Force`, in either order.
  { re: /\b(ri|rm|del|erase|rd|rmdir|Remove-Item)\b[^|;\n]*\s-(Rec|Fo)\w*/i, why: "recursive/forced delete" },
  // `Get-ChildItem -Recurse | Remove-Item`: the recursion sits on the
  // producer, and every delete later in the pipeline inherits it.
  { re: /-Rec\w*\b[^\n]*\|\s*(Remove-Item|ri|rm|del|erase|rd|rmdir)\b/i, why: "recursive delete" },
  { re: /\bformat\b\s+[a-z]:/i, why: "disk format" },
  { re: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|diskpart)\b/i, why: "disk or partition wipe" },
  { re: /\bmkfs(\.\w+)?\b/, why: "filesystem format" },
  { re: /\bdd\s+.*of=\/dev\//, why: "raw device write" },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "power state change" },
  { re: /\bStop-Computer\b|\bRestart-Computer\b/i, why: "power state change" },
  { re: /\bgit\s+push\b.*(--force\b(?!-with-lease)|-f\b)/, why: "force push" },
  // `git push origin +main`: a leading `+` on the refspec is a force push
  // that never says the word.
  { re: /\bgit\s+push\b[^|;\n]*\s\+\S/, why: "force push" },
  { re: /\bgit\s+push\b.*--force-with-lease\b/, why: "force push with lease" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "discards local changes" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, why: "deletes untracked files" },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: "pipes remote script to shell" },
  { re: /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: "pipes remote script to shell" },
  { re: /\bInvoke-Expression\b|\biex\b\s*\(/i, why: "evaluates dynamic code" },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, why: "publishes a package" },
  { re: /\bsudo\b|\brunas\b/i, why: "elevates privileges" },
  { re: /\b(chmod|chown)\s+-R\b/, why: "recursive permission change" },
  { re: /\breg\s+delete\b/i, why: "registry delete" },
  { re: /\bcipher\s+\/w/i, why: "wipes free space" },
  { re: /\bvssadmin\b.*delete/i, why: "deletes shadow copies" },
];

export interface DangerAssessment {
  dangerous: boolean;
  reasons: string[];
}

export function assessCommand(command: string): DangerAssessment {
  const reasons: string[] = [];
  for (const { re, why } of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) reasons.push(why);
  }
  return { dangerous: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * What "always allow" remembers: this command, not a class of them.
 *
 * It used to return the first token — or the first two for subcommand-driven
 * tools — and a later command sharing that head was then treated as already
 * approved. An external audit demonstrated the consequence against the
 * shipped build: approving anything beginning with `python` stored the key
 * `python`, after which `python -c "…"` ran with no prompt at all. The same
 * held for `npm`, `git`, every shell interpreter, and every command whose
 * arguments *are* its behaviour.
 *
 * The button said "Always allow python", which described the grant
 * accurately — and the accuracy is exactly what made it invisible. Nobody
 * reads that as "and anything else I ever run through Python".
 *
 * So an implicit grant is now exact. Whitespace is normalised, because two
 * commands differing only in spacing are the same command, and nothing else
 * is folded. Anyone who genuinely wants a class can still say so with a rule
 * (`git *: allow`) — a decision written down deliberately rather than
 * inferred from one click on one prompt.
 */
export function commandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Where one command ends and the next begins, for either shell.
 *
 * A remembered key has to be checked against every command on the line, not
 * the first: an allowlisted `git status` used to clear `git status && ri
 * -Recurse -Force C:\proj` on the strength of its first word. Separators,
 * newlines and both command substitutions all split. A `|` inside quotes
 * splits too, which costs the user a prompt rather than a bypass.
 */
/**
 * Remove the bodies of here-documents before anything is split.
 *
 * A here-doc body is not quoted, so quote-aware splitting walks straight
 * into it and treats every line as another command. Reported from a live
 * install where the allowlist had grown to 112 entries holding prose -
 * `five`, `each`, `appreciated.`, `0.10.10` - because a bug report had been
 * written to disk with `cat > report.md <<'EOF'` and each line of it was
 * read as a command that had just been approved.
 *
 * The validator cannot catch this: `five` is a perfectly plausible command
 * name and there is no way to tell it from one. The body has to not be
 * parsed in the first place.
 *
 * Bodies are dropped rather than kept, because nothing inside one is ever a
 * command to remember - it is data on its way to a file.
 */
export function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    kept.push(line);
    index++;

    // Several on one line is legal: `cmd <<A <<B`. Each body follows in
    // the order its delimiter was named.
    const delimiters = [...line.matchAll(/(?<!<)<<(?!<)-?\s*(?:(['"])([A-Za-z_][\w]*)\1|([A-Za-z_][\w]*))/g)]
      .map((match) => match[2] ?? match[3])
      .filter(Boolean);

    for (const delimiter of delimiters) {
      while (index < lines.length) {
        const body = lines[index];
        index++;
        if (body.trim() === delimiter) break;
      }
    }
  }
  return kept.join("\n");
}
/**
 * Split a line into the commands it actually runs.
 *
 * Quote-aware, which the regex this replaces was not. Splitting blindly on
 * `;` `|` and newlines cut straight through quoted arguments, and each
 * fragment was then treated as a command in its own right - so approving
 * `sqlite3 db "select ... ; ... vnc"` stored `"select` and `vnc"` as
 * allowlist keys. Found in two live configs: quote fragments on one machine,
 * and `$os`, `$path`, `$magick` on another, where PowerShell assignments
 * split on newlines and each variable name became a "command".
 *
 * Text inside single or double quotes is now carried along whole, so a
 * separator only separates when the shell would treat it as one.
 */
export function splitCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      // A backslash escapes the closing quote in double quotes only; inside
      // single quotes the shell takes every character literally.
      if (ch === quote && !(quote === '"' && command[i - 1] === "\\")) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const pair = command.slice(i, i + 2);
    if (pair === "||" || pair === "&&" || pair === "$(") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r" || ch === "`") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * Shell control words, which must never become allowlist keys.
 *
 * Clearing `if` would clear every compound command that begins with one,
 * which is not what anyone means by approving a command. They reached the
 * list the same way the quote fragments did.
 */
const CONTROL_WORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "select", "function", "in",
]);

/** Privilege escalation is never remembered, whatever the mode. */
const NEVER_REMEMBER = new Set(["sudo", "su", "doas", "runas"]);

/**
 * Is this key a command name worth storing?
 *
 * The allowlist only ever grows, so anything junk that gets in stays in and
 * widens the permission surface for the rest of the install's life. A key
 * has to look like a command: no shell punctuation, not a bare sigil, not a
 * variable assignment, long enough to mean something, and not a control word
 * or a way to become root.
 */
export function isStorableCommandKey(key: string): boolean {
  if (key.length < 2) return false;
  // Long enough to be a command, short enough that the list cannot be filled
  // with one enormous entry.
  if (key.length > 400) return false;
  // Command substitution is refused, and only command substitution.
  //
  // The old rule rejected quotes and separators too, which made sense when a
  // key was a prefix: the rest of the line was thrown away, so anything in it
  // was an unknown. An exact key keeps the whole command, and `splitCommands`
  // has already honoured quoting — a `;` surviving into a segment is literal
  // text inside a string, not a second command. Refusing those would mean the
  // "always allow" button silently doing nothing for any command containing a
  // quote, which is its own kind of dishonesty.
  //
  // Substitution is different in kind. `$(…)` and backticks are a command
  // whose text is decided when it runs, so the same stored string is not the
  // same work twice, and an exact match gives no protection at all.
  if (/[`]/.test(key) || key.includes("$(")) return false;
  const head = key.split(" ")[0];
  if (CONTROL_WORDS.has(head) || NEVER_REMEMBER.has(head)) return false;
  // A variable assignment is an environment, not a command.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false;
  // The head still has to look like a program: a bare name or a path. The
  // arguments after it are free, because they are now part of what was
  // approved rather than something the key throws away.
  return /^[a-z0-9._/\\:+-]+$/i.test(head);
}

/** The allowlist key of every command on the line, in order. */
export function commandKeys(command: string): string[] {
  const keys: string[] = [];
  for (const segment of splitCommands(stripHeredocBodies(command))) {
    const key = commandKey(segment);
    if (key) keys.push(key);
  }
  return keys;
}

export interface PolicyState {
  mode: ApprovalMode;
  /** Command keys cleared for the rest of the session (or persisted). */
  allowedCommands: Set<string>;
  /** Absolute directories where writes are pre-cleared. */
  allowedWriteDirs: Set<string>;
  /** Workspace root; writes outside it are treated as out-of-scope. */
  workspace: string;
  /** Per-command rules, which outrank the mode. */
  bashRules?: BashRules;
}

export function createPolicy(
  workspace: string,
  mode: ApprovalMode,
  seed?: { commands?: string[]; writeDirs?: string[]; bashRules?: BashRules }
): PolicyState {
  return {
    mode,
    workspace: path.resolve(workspace),
    // Filtered, not trusted: every install that ran an earlier build has
    // junk in here already, and it is written back on the next save, so
    // dropping it on load is what actually clears it.
    allowedCommands: new Set((seed?.commands ?? []).filter(isStorableCommandKey)),
    allowedWriteDirs: new Set((seed?.writeDirs ?? []).map((d) => path.resolve(d))),
    bashRules: seed?.bashRules,
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Where a path really leads, following any symlink on the way.
 *
 * `path.resolve` is lexical: it cancels `..` and joins, and knows nothing
 * about links. So `workspace/linked/file` looks contained whatever `linked`
 * points at, the policy clears it as a workspace edit, and `writeFileSync`
 * then follows the link and writes outside. A repository containing one
 * symlink turns an auto-approved workspace edit into an external write, and
 * the approval dialog shows the lexical path, which conceals it.
 *
 * A file that does not exist yet cannot be resolved, so the nearest existing
 * ancestor is resolved instead and the remainder joined back on — which is
 * the part that matters, since the link is always a *directory* on the way.
 *
 * Both sides of a containment test must go through this. On macOS `/tmp` is
 * itself a link to `/private/tmp`, so canonicalising only the target would
 * put an ordinary workspace write outside its own workspace.
 */
export function realPath(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  // Bounded: a path has finitely many segments, and the loop consumes one
  // each time it fails.
  for (let depth = 0; depth < 64; depth++) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      // The root does not exist either: nothing to canonicalise, so the
      // lexical answer is the only one available.
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

export type PolicyVerdict =
  | { outcome: "allow"; reason?: string }
  | { outcome: "deny"; reason: string }
  | { outcome: "ask"; reason: string; dangerous: boolean };

/**
 * Decide statically what to do with a request. "ask" means the caller must
 * surface an interactive prompt (or auto-deny in non-interactive runs).
 */
export function evaluate(policy: PolicyState, req: PermissionRequest): PolicyVerdict {
  if (req.kind === "read") return { outcome: "allow" };

  if (policy.mode === "read-only") {
    return {
      outcome: "deny",
      reason:
        "read-only mode is active — writes and commands are blocked. Switch with /approve ask (or --approve ask).",
    };
  }

  if (req.kind === "write") {
    // Where the write really lands, not where the path says it does.
    // Both sides are canonicalised: see `realPath`.
    const target = req.targetPath ? realPath(req.targetPath) : undefined;
    const workspace = realPath(policy.workspace);
    const inWorkspace = target ? isInside(workspace, target) : false;
    const preCleared =
      target && [...policy.allowedWriteDirs].some((d) => isInside(realPath(d), target));

    if (preCleared) return { outcome: "allow", reason: "directory previously approved" };
    if (policy.mode === "yolo") return { outcome: "allow" };
    if (policy.mode === "full-auto" || policy.mode === "auto-edit") {
      if (inWorkspace) return { outcome: "allow", reason: "workspace edit" };
      return {
        outcome: "ask",
        reason: "writes outside the workspace always need approval",
        dangerous: true,
      };
    }
    return { outcome: "ask", reason: "file write", dangerous: !inWorkspace };
  }

  if (req.kind === "command") {
    const danger = assessCommand(req.subject);

    // An explicit rule is the user's own decision about this exact command, so
    // it outranks the mode in both directions — including `deny` under yolo,
    // which is the point of writing a deny rule at all.
    const rule = matchBashRule(req.subject, policy.bashRules);
    if (rule?.action === "deny") {
      return {
        outcome: "deny",
        reason: `blocked by your rule "${rule.pattern}: deny" — change it with /permission`,
      };
    }
    if (rule?.action === "allow") {
      return { outcome: "allow", reason: `matched your rule "${rule.pattern}: allow"` };
    }
    if (rule?.action === "ask") {
      return { outcome: "ask", reason: `your rule "${rule.pattern}: ask"`, dangerous: danger.dangerous };
    }

    if (policy.mode === "yolo") return { outcome: "allow" };
    if (danger.dangerous) {
      return {
        outcome: "ask",
        reason: `flagged: ${danger.reasons.join(", ")}`,
        dangerous: true,
      };
    }
    // Every command on the line has to be cleared, not just the first — the
    // destructive check above already saw the whole line, this has to too.
    const keys = commandKeys(req.subject);
    if (keys.length > 0 && keys.every((key) => policy.allowedCommands.has(key))) {
      const named = [...new Set(keys)].map((key) => `"${key}"`).join(", ");
      return { outcome: "allow", reason: `${named} previously approved` };
    }
    if (policy.mode === "full-auto") return { outcome: "allow" };
    return { outcome: "ask", reason: "shell command", dangerous: false };
  }

  // network
  if (policy.mode === "yolo" || policy.mode === "full-auto") return { outcome: "allow" };
  return { outcome: "ask", reason: "network request", dangerous: false };
}

/** Record an "always allow" answer against the policy. */
export function remember(policy: PolicyState, req: PermissionRequest): void {
  if (req.kind === "command") {
    // The user cleared the whole line, so each command on it is cleared -
    // except the ones that are not commands. A key that cannot be stored is
    // still allowed for this call; it simply is not written down, so the
    // line is asked about again rather than widening the allowlist for good.
    for (const key of commandKeys(req.subject)) {
      if (isStorableCommandKey(key)) policy.allowedCommands.add(key);
    }
  } else if (req.kind === "write" && req.targetPath) {
    policy.allowedWriteDirs.add(path.dirname(path.resolve(req.targetPath)));
  }
}

// ---------------------------------------------------------------------------
// per-command rules
// ---------------------------------------------------------------------------

/**
 * A rule's verdict for one command. Mirrors the vocabulary OpenCode settled on,
 * which is the right shape: a binary allowlist cannot express "everything asks
 * except git, and never rm".
 */
export type RuleAction = "allow" | "ask" | "deny";

export const RULE_ACTIONS: RuleAction[] = ["allow", "ask", "deny"];

export function isRuleAction(v: string): v is RuleAction {
  return (RULE_ACTIONS as string[]).includes(v);
}

/**
 * Command patterns mapped to verdicts, e.g.
 *
 *   { "*": "ask", "git *": "allow", "rm *": "deny" }
 *
 * `*` matches any run of characters, `?` matches one. Insertion order decides
 * ties: the **last** matching rule wins, so a catch-all is written first and
 * refined afterwards.
 */
export type BashRules = Record<string, RuleAction>;

function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern.trim()) {
    // `.` stops at a newline and `command: |` bodies contain them, so `rm *`
    // used to match `rm -rf build` and miss `rm -rf build\necho done`.
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Anchored so "git *" cannot match "mygit foo".
  return new RegExp(`^${out}$`, "i");
}

export interface RuleMatch {
  action: RuleAction;
  pattern: string;
}

/**
 * Resolve a command against the rule table. Returns the last match, or null
 * when no rule applies and the approval mode should decide.
 */
export function matchBashRule(command: string, rules: BashRules | undefined): RuleMatch | null {
  if (!rules) return null;
  const subject = command.trim();
  let winner: RuleMatch | null = null;
  for (const [pattern, action] of Object.entries(rules)) {
    if (!isRuleAction(action)) continue;
    try {
      if (patternToRegExp(pattern).test(subject)) winner = { action, pattern };
    } catch {
      // A pattern that cannot compile is ignored rather than fatal — a typo in
      // config should not stop the agent from running.
    }
  }
  return winner;
}
