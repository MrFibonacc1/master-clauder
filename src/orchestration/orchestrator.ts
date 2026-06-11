/**
 * Orchestrator — single planner call to decompose a task into subtasks with
 * disjoint file-glob ownership, plus event digesting and a "do we even need a
 * plan?" heuristic.
 */
import { globsMayOverlap, type CoordinationStore } from '../core/store.js';
import type { Plan, PlannedSubtask, Tier } from '../shared/types.js';

/** Minimal local interface — avoids depending on the concrete ModelClient. */
export interface ModelClientLike {
  complete(opts: {
    taskId: string;
    model: string;
    system?: string;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
  }): Promise<string>;
}

export const PLANNER_SYSTEM = `You are a software task planner. Decompose the given task into independent subtasks
that can be executed in parallel by separate coding agents. Each subtask MUST own a
disjoint set of file-path globs ("ownership") — no two subtasks may touch the same files.
Respond with JSON only: {"subtasks":[{"title","prompt","ownership":[globs],"suggestedTier":"cheap"|"mid"|"top"}],"notes"}`;

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['subtasks'],
  properties: {
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'prompt', 'ownership', 'suggestedTier'],
        properties: {
          title: { type: 'string' },
          prompt: { type: 'string' },
          ownership: { type: 'array', items: { type: 'string' } },
          suggestedTier: { type: 'string', enum: ['cheap', 'mid', 'top'] },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const VALID_TIERS: Tier[] = ['cheap', 'mid', 'top', 'max'];

export class Orchestrator {
  constructor(
    private deps: { store: CoordinationStore; modelClientLike: ModelClientLike; plannerModel: string },
  ) {}

  async plan(task: { id: string; title: string; repo: string }, memoryContext: string): Promise<Plan> {
    const prompt = [
      `Repo: ${task.repo}`,
      `Task: ${task.title}`,
      memoryContext ? `Relevant memory:\n${memoryContext}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const raw = await this.deps.modelClientLike.complete({
      taskId: task.id,
      model: this.deps.plannerModel,
      system: PLANNER_SYSTEM,
      prompt,
      jsonSchema: PLAN_SCHEMA,
    });

    const parsed = JSON.parse(raw) as { subtasks?: unknown; notes?: unknown };
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      throw new Error('planner returned no subtasks');
    }

    const subtasks: PlannedSubtask[] = parsed.subtasks.map((s, i) => {
      const st = s as Partial<PlannedSubtask>;
      if (!st.title || !st.prompt || !Array.isArray(st.ownership) || st.ownership.length === 0) {
        throw new Error(`planner subtask ${i} is missing title/prompt/ownership`);
      }
      return {
        title: st.title,
        prompt: st.prompt,
        ownership: st.ownership,
        suggestedTier: VALID_TIERS.includes(st.suggestedTier as Tier) ? (st.suggestedTier as Tier) : 'mid',
      };
    });

    return { subtasks: fixOverlappingOwnership(subtasks), notes: typeof parsed.notes === 'string' ? parsed.notes : undefined };
  }
}

/**
 * If any two subtasks' globs may overlap, deterministically namespace every
 * subtask's globs under a per-subtask prefix (no second model call).
 */
export function fixOverlappingOwnership(subtasks: PlannedSubtask[]): PlannedSubtask[] {
  let overlapping = false;
  outer: for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      for (const a of subtasks[i].ownership) {
        for (const b of subtasks[j].ownership) {
          if (globsMayOverlap(a, b)) {
            overlapping = true;
            break outer;
          }
        }
      }
    }
  }
  if (!overlapping) return subtasks;
  return subtasks.map((st, i) => ({
    ...st,
    ownership: st.ownership.map((g) => `subtask-${i}/${g.replace(/^\/+/, '')}`),
  }));
}

/** Compact text digest of recent events for a repo, for injection into agent prompts. */
export function digestRecentEvents(store: CoordinationStore, repo: string, limit = 20): string {
  const events = store.eventsSince(0, 1000).slice(-200);
  const lines: string[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (p.repo !== undefined && p.repo !== repo) continue;
    const who = e.agentId ? `[${e.agentId}]` : '';
    switch (e.type) {
      case 'agent.status':
        lines.push(`${who} status: ${String(p.status)}${p.summary ? ` — ${String(p.summary).slice(0, 80)}` : ''}`);
        break;
      case 'agent.tool':
        lines.push(`${who} used ${String(p.name)}`);
        break;
      case 'merge.submitted':
        lines.push(`${who} submitted branch ${String(p.branch)} for merge`);
        break;
      case 'merge.result':
        lines.push(`${who} merge ${String(p.branch)}: ${String(p.status)}`);
        break;
      case 'claim.acquired':
        lines.push(`${who} claimed ${JSON.stringify(p.globs)}`);
        break;
      case 'claim.released':
        lines.push(`${who} released claims`);
        break;
      default:
        break;
    }
  }
  return lines.slice(-limit).join('\n');
}

/** Heuristic: does this task title look big enough to need a planning pass? */
export function needsPlanning(title: string): boolean {
  const t = title.toLowerCase();
  const conjunctions = (t.match(/\band\b|\bthen\b|[;,]|\+/g) ?? []).length;
  if (conjunctions >= 2) return true;
  if (/\b(refactor|migrate|redesign|rewrite|overhaul|implement .* across)\b/.test(t)) return true;
  if (t.split(/\s+/).length > 15) return true;
  return false;
}
