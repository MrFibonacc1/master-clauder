/**
 * Cost-aware task routing: explicit override → keyword heuristics →
 * (optional) one cheap classifier call → clamp to maxModel.
 */
import type { RoutingDecision, Tier } from '../shared/types.js';
import { MODEL_CATALOG, modelForTier } from './models.js';
import type { ModelClient } from './modelClient.js';

export const TIER_ORDER: Tier[] = ['cheap', 'mid', 'top', 'max'];

export interface HeuristicRule {
  pattern: RegExp;
  tier: Tier;
  reason: string;
}

/** Table-driven heuristics, checked in order; first match wins. */
export const HEURISTIC_RULES: HeuristicRule[] = [
  { pattern: /\brename\b/i, tier: 'cheap', reason: 'rename task' },
  { pattern: /\btypo\b/i, tier: 'cheap', reason: 'typo fix' },
  { pattern: /\bformat(ting)?\b/i, tier: 'cheap', reason: 'formatting task' },
  { pattern: /\bcomment(s)?\b/i, tier: 'cheap', reason: 'comment-only change' },
  { pattern: /\bbump\s+version\b/i, tier: 'cheap', reason: 'version bump' },
  { pattern: /\badd\s+log(ging|s)?\b/i, tier: 'cheap', reason: 'add logging' },
  { pattern: /\brefactor\s+(the\s+)?entire\b/i, tier: 'top', reason: 'large refactor' },
  { pattern: /\barchitect(ure|ural)?\b/i, tier: 'top', reason: 'architecture work' },
  { pattern: /\bredesign\b/i, tier: 'top', reason: 'redesign' },
  { pattern: /\bdebug\s+(a\s+)?race\b/i, tier: 'top', reason: 'race-condition debugging' },
  { pattern: /\bmigrat(e|ion)\b/i, tier: 'top', reason: 'migration' },
  { pattern: /\bperf(ormance)?\b/i, tier: 'top', reason: 'performance work' },
];

const TRIVIAL_VERBS = /^(fix|update|add|remove|delete|change|tweak|adjust|bump|rename)\b/i;

/** Clamp a tier to the configured ceiling (cheap < mid < top < max). */
export function clampTier(tier: Tier, maxModel: Tier): Tier {
  return TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(maxModel) ? maxModel : tier;
}

/** One tier up from current, capped at maxModel. Null if already at the cap. */
export function escalate(current: Tier, maxModel: Tier): Tier | null {
  const i = TIER_ORDER.indexOf(current);
  const cap = TIER_ORDER.indexOf(maxModel);
  return i >= cap ? null : TIER_ORDER[i + 1];
}

/** Run heuristics only; returns null when ambiguous. Exported for tests. */
export function heuristicTier(title: string): { tier: Tier; reason: string } | null {
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(title)) return { tier: rule.tier, reason: rule.reason };
  }
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length < 6 && TRIVIAL_VERBS.test(title.trim())) {
    return { tier: 'cheap', reason: 'short trivial task' };
  }
  return null;
}

export interface RouteTaskOptions {
  taskId: string;
  title: string;
  repoName: string;
  maxModel: Tier;
  defaultTier: Tier;
  override?: string;
  client?: ModelClient;
}

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: TIER_ORDER },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['tier', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

export async function routeTask(opts: RouteTaskOptions): Promise<RoutingDecision> {
  const decide = (tier: Tier, reason: string, source: RoutingDecision['source']): RoutingDecision => {
    const clamped = clampTier(tier, opts.maxModel);
    return {
      taskId: opts.taskId,
      tier: clamped,
      model: modelForTier(clamped).id,
      reason: clamped === tier ? reason : `${reason} (clamped to ${clamped})`,
      source,
      ts: Date.now(),
    };
  };

  // (a) explicit override wins — accepts a tier name or a model id.
  if (opts.override) {
    const byTier = TIER_ORDER.includes(opts.override as Tier) ? (opts.override as Tier) : undefined;
    const byModel = (Object.keys(MODEL_CATALOG) as Tier[]).find(
      (t) => MODEL_CATALOG[t].id === opts.override,
    );
    const tier = byTier ?? byModel;
    if (tier) return decide(tier, `explicit override: ${opts.override}`, 'override');
  }

  // (b) heuristics
  const h = heuristicTier(opts.title);
  if (h) return decide(h.tier, h.reason, 'heuristic');

  // (c) one classifier call on the cheap model, billed to the task
  if (opts.client) {
    try {
      const text = await opts.client.complete({
        taskId: opts.taskId,
        model: MODEL_CATALOG.cheap.id,
        system:
          'You classify coding tasks into a model tier: cheap (trivial edits), mid (typical features/bugs), top (complex/cross-cutting), max (extremely hard). Respond with JSON only.',
        prompt: `Repo: ${opts.repoName}\nTask: ${opts.title}`,
        maxTokens: 256,
        jsonSchema: CLASSIFIER_SCHEMA,
      });
      const parsed = JSON.parse(text) as { tier: Tier; confidence: number; reason: string };
      if (TIER_ORDER.includes(parsed.tier) && parsed.confidence >= 0.5) {
        return decide(parsed.tier, parsed.reason, 'classifier');
      }
    } catch {
      // fall through to default
    }
  }

  return decide(opts.defaultTier, 'default tier (no heuristic/classifier signal)', 'heuristic');
}
