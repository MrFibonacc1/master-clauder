/**
 * CliModelClient — drop-in alternative to ModelClient that runs lightweight
 * completions (router classifier, planner) through the local `claude` CLI in
 * headless mode (`claude -p ... --output-format json`).
 *
 * Why: uses the user's Claude Code subscription login — no ANTHROPIC_API_KEY
 * needed. Usage and cost are taken from the CLI's JSON result and recorded in
 * the coordination store, so the dashboard shows real spend.
 */
import { execFile } from 'node:child_process';
import type { CoordinationStore } from './store.js';
import type { BudgetConfig } from '../shared/types.js';
import { BudgetExceededError, startOfToday, type CompleteOptions } from './modelClient.js';

const CLI_TIMEOUT_MS = 5 * 60 * 1000;

interface CliResult {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class CliModelClient {
  constructor(
    private store: CoordinationStore,
    private budget: BudgetConfig,
    private bin = 'claude',
  ) {}

  /** True if the `claude` CLI is on PATH (cheap, cached). */
  static available(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'where' : 'which', ['claude'], (err) => resolve(!err));
    });
  }

  async complete(opts: CompleteOptions): Promise<string> {
    this.enforceBudget(opts.taskId);

    let prompt = opts.prompt;
    if (opts.jsonSchema) {
      prompt += `\n\nRespond with ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(opts.jsonSchema)}`;
    }

    const args = ['-p', prompt, '--model', opts.model, '--output-format', 'json'];
    if (opts.system) args.push('--append-system-prompt', opts.system);

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(this.bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) reject(new Error(`claude CLI failed: ${err.message}\n${errOut.slice(0, 500)}`));
        else resolve(out);
      });
    });

    const parsed = JSON.parse(stdout) as CliResult;
    const u = parsed.usage ?? {};
    this.store.recordUsage({
      taskId: opts.taskId,
      agentId: opts.agentId,
      model: opts.model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: parsed.total_cost_usd ?? 0,
      ts: Date.now(),
    });

    if (parsed.is_error) throw new Error(`claude CLI returned error: ${(parsed.result ?? '').slice(0, 500)}`);
    const text = parsed.result ?? '';
    return opts.jsonSchema ? extractJson(text) : text;
  }

  private enforceBudget(taskId: string): void {
    const checks = [
      { scope: 'task' as const, spent: this.store.costForTask(taskId), limit: this.budget.perTaskUsd },
      { scope: 'day' as const, spent: this.store.costForDay(startOfToday()), limit: this.budget.perDayUsd },
    ];
    for (const c of checks) {
      if (c.limit <= 0) continue;
      if (c.spent >= c.limit) {
        this.store.append({ ts: Date.now(), type: 'budget.stop', taskId, payload: { ...c } });
        throw new BudgetExceededError(c.scope, c.spent, c.limit);
      }
      if (c.spent >= c.limit * this.budget.warnRatio) {
        this.store.append({ ts: Date.now(), type: 'budget.warn', taskId, payload: { ...c } });
      }
    }
  }
}

/** Pull the first top-level JSON object out of model text (tolerates fences/prose). */
export function extractJson(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
    } else if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}
