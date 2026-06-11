/**
 * ModelClient — thin wrapper around the raw Anthropic Messages API for
 * Cortex's direct calls (routing classifier, memory summarization).
 * Records usage in the CoordinationStore and enforces budget caps.
 *
 * API key comes from the environment only (ANTHROPIC_API_KEY).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BudgetConfig, Usage } from '../shared/types.js';
import type { CoordinationStore } from './store.js';
import { costUsd } from './models.js';

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: 'task' | 'day',
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`Budget exceeded (${scope}): $${spentUsd.toFixed(4)} >= $${limitUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

export interface CompleteOptions {
  taskId: string;
  agentId?: string;
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  jsonSchema?: object;
}

export function startOfToday(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class ModelClient {
  private client: Anthropic;

  constructor(
    private store: CoordinationStore,
    private budget: BudgetConfig,
    client?: Anthropic,
  ) {
    // No apiKey arg: the SDK reads ANTHROPIC_API_KEY from the environment.
    this.client = client ?? new Anthropic();
  }

  /** Returns the concatenated assistant text. Usage is recorded in the store. */
  async complete(opts: CompleteOptions): Promise<string> {
    this.enforceBudget(opts.taskId, opts.agentId);

    const params: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: 'user', content: opts.prompt }],
    };
    if (opts.system) params.system = opts.system;
    if (opts.jsonSchema) {
      params.output_config = { format: { type: 'json_schema', schema: opts.jsonSchema } };
    }
    // NOTE: never pass temperature/top_p — removed on current models.

    // Cast: output_config may be ahead of the installed SDK's types.
    const response = await this.client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsNonStreaming,
    );

    const u = response.usage;
    const usage: Usage = {
      taskId: opts.taskId,
      agentId: opts.agentId,
      model: opts.model,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: costUsd(
        opts.model,
        u.input_tokens,
        u.output_tokens,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      ),
      ts: Date.now(),
    };
    this.store.recordUsage(usage);

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  /** Throws BudgetExceededError at the hard cap; emits budget.warn at warnRatio. */
  private enforceBudget(taskId: string, agentId?: string): void {
    const checks: { scope: 'task' | 'day'; spent: number; limit: number }[] = [
      { scope: 'task', spent: this.store.costForTask(taskId), limit: this.budget.perTaskUsd },
      { scope: 'day', spent: this.store.costForDay(startOfToday()), limit: this.budget.perDayUsd },
    ];
    for (const { scope, spent, limit } of checks) {
      if (spent >= limit) {
        this.store.append({
          ts: Date.now(),
          type: 'budget.stop',
          taskId,
          agentId,
          payload: { scope, spentUsd: spent, limitUsd: limit },
        });
        throw new BudgetExceededError(scope, spent, limit);
      }
      if (spent >= limit * this.budget.warnRatio) {
        this.store.append({
          ts: Date.now(),
          type: 'budget.warn',
          taskId,
          agentId,
          payload: { scope, spentUsd: spent, limitUsd: limit, ratio: spent / limit },
        });
      }
    }
  }
}
