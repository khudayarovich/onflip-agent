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
  { re: /\brmdir\s+\/s/i, why: "recursive directory delete" },
  { re: /\bdel\s+.*\/[sfq]/i, why: "forced delete" },
  { re: /\bRemove-Item\b.*-Recurse/i, why: "recursive delete" },
  { re: /\bformat\b\s+[a-z]:/i, why: "disk format" },
  { re: /\bmkfs(\.\w+)?\b/, why: "filesystem format" },
  { re: /\bdd\s+.*of=\/dev\//, why: "raw device write" },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "power state change" },
  { re: /\bStop-Computer\b|\bRestart-Computer\b/i, why: "power state change" },
  { re: /\bgit\s+push\b.*(--force\b|-f\b)/, why: "force push" },
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

/** First meaningful token of a command, used as the allowlist key. */
export function commandKey(command: string): string {
  const cleaned = command.trim().replace(/^[(\s{]+/, "");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const head = parts[0].toLowerCase();
  // Two-word keys read far better for subcommand-driven tools.
  const SUBCOMMAND_TOOLS = new Set([
    "git", "npm", "npx", "pnpm", "yarn", "cargo", "go", "docker", "kubectl",
    "dotnet", "pip", "python", "poetry", "gh", "terraform", "make",
  ]);
  if (SUBCOMMAND_TOOLS.has(head) && parts[1] && !parts[1].startsWith("-")) {
    return `${head} ${parts[1].toLowerCase()}`;
  }
  return head;
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
    allowedCommands: new Set(seed?.commands ?? []),
    allowedWriteDirs: new Set((seed?.writeDirs ?? []).map((d) => path.resolve(d))),
    bashRules: seed?.bashRules,
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
    const target = req.targetPath ? path.resolve(req.targetPath) : undefined;
    const inWorkspace = target ? isInside(policy.workspace, target) : false;
    const preCleared =
      target && [...policy.allowedWriteDirs].some((d) => isInside(d, target));

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
    const key = commandKey(req.subject);
    if (key && policy.allowedCommands.has(key)) {
      return { outcome: "allow", reason: `"${key}" previously approved` };
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
    const key = commandKey(req.subject);
    if (key) policy.allowedCommands.add(key);
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
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
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
