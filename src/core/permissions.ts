/**
 * Autonomy policy: decides which agent tool calls are auto-granted vs gated,
 * without a human in the loop. The goal is that the safe ~95% (reads, edits and
 * commits inside the agent's own worktree, tests, builds, ordinary git) just
 * run, while the genuinely dangerous few (push, force, rm -rf, publish, sudo,
 * writes outside the worktree) are blocked with an actionable message so the
 * agent adapts and the run continues unattended.
 */
import path from 'node:path';
import type { Autonomy } from '../shared/types.js';

export type { Autonomy };

export type ToolDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'BashOutput',
  'ListMcpResources',
  'ReadMcpResource',
]);

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update']);

/** Bash commands that are clearly destructive / outward-facing — the gated 5%. */
const RISKY_BASH: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'recursive force delete (rm -rf)' },
  { re: /\bgit\s+push\b/i, why: 'git push (the merge queue is the only writer to main)' },
  { re: /--force\b|--hard\b/i, why: 'a --force / --hard git operation' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'git reset --hard' },
  { re: /\bgit\s+checkout\s+(?:main|master)\b/i, why: 'checking out the main branch' },
  { re: /\bgit\s+branch\s+-D\b/i, why: 'force-deleting a branch' },
  { re: /\b(?:npm|yarn|pnpm)\s+publish\b/i, why: 'publishing a package' },
  { re: /\btwine\s+upload\b|\bpip\b.*\bupload\b/i, why: 'uploading a package' },
  { re: /\bsudo\b|\bdoas\b/i, why: 'elevated privileges (sudo)' },
  { re: /\bmkfs\b|\bdd\s+if=/i, why: 'a disk-level operation' },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/i, why: 'a power/shutdown command' },
  { re: /\bchmod\s+-R\s+777\b/i, why: 'a world-writable recursive chmod' },
  { re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i, why: 'piping a download into a shell' },
  { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;/, why: 'a fork bomb' },
  { re: />\s*\/dev\/(?:sd|disk|nvme)/i, why: 'writing to a raw device' },
];

/** Bash that only reads/inspects — safe even in careful mode. */
const READ_ONLY_BASH =
  /^\s*(?:ls|pwd|echo|cat|head|tail|wc|grep|rg|find|fd|which|file|stat|tree|env|printenv|date|whoami|node\s+-v|npm\s+(?:ls|view|outdated)|git\s+(?:status|diff|log|show|branch|remote|rev-parse|ls-files|config\s+--get)\b)/i;

function isInsideWorktree(worktree: string, p: string | undefined): boolean {
  if (!p) return true;
  if (!path.isAbsolute(p)) return true; // relative paths resolve against the worktree cwd
  const wt = path.resolve(worktree);
  const target = path.resolve(p);
  return target === wt || target.startsWith(wt + path.sep);
}

/** Extract a likely filesystem-path argument from a write tool's input. */
function toolPath(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Returns a reason string if the bash command is risky, else null. */
function bashRisk(command: string, worktree: string): string | null {
  for (const { re, why } of RISKY_BASH) if (re.test(command)) return why;
  // redirecting/writing to an absolute path outside the worktree
  const redirect = command.match(/>>?\s*("?)(\/[^\s"'|;&]+)\1/);
  if (redirect && !isInsideWorktree(worktree, redirect[2])) {
    return `writing to ${redirect[2]} (outside the worktree)`;
  }
  return null;
}

const hint = (autonomy: Autonomy) =>
  autonomy === 'careful'
    ? ' Re-run the task with standard or --yolo autonomy to allow this.'
    : ' Re-run the task with --yolo (full autonomy) to allow this, or do it yourself.';

/**
 * Decide whether a tool call is auto-allowed or gated under the given autonomy.
 * Pure and synchronous — the runner wraps it in the SDK's canUseTool callback.
 */
export function evaluateTool(
  autonomy: Autonomy,
  toolName: string,
  input: Record<string, unknown>,
  worktree: string,
): ToolDecision {
  if (autonomy === 'full') return { behavior: 'allow' };

  const isBash = toolName === 'Bash';
  const command = isBash ? String(input.command ?? '') : '';

  // The dangerous few are gated regardless of standard vs careful.
  if (isBash) {
    const risk = bashRisk(command, worktree);
    if (risk) return { behavior: 'deny', message: `Blocked by autonomy policy: ${risk}.${hint(autonomy)}` };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const p = toolPath(input);
    if (!isInsideWorktree(worktree, p)) {
      return {
        behavior: 'deny',
        message: `Blocked by autonomy policy: writing outside the worktree (${p}).${hint(autonomy)}`,
      };
    }
  }

  if (autonomy === 'standard') {
    // Allow everything that isn't in the gated set above.
    return { behavior: 'allow' };
  }

  // careful: read-and-plan. Allow read-only tools and read-only bash; gate the rest.
  if (READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow' };
  if (isBash && READ_ONLY_BASH.test(command)) return { behavior: 'allow' };
  if (isBash) {
    return { behavior: 'deny', message: `Careful autonomy: this command may change state.${hint(autonomy)}` };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return { behavior: 'deny', message: `Careful autonomy: file edits are gated.${hint(autonomy)}` };
  }
  return { behavior: 'allow' };
}
