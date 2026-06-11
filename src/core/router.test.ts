import { describe, expect, it } from 'vitest';
import type { Tier } from '../shared/types.js';
import { clampTier, escalate, heuristicTier, routeTask } from './router.js';

const base = { taskId: 't1', repoName: 'my-app', maxModel: 'max' as Tier, defaultTier: 'mid' as Tier };

describe('heuristics (table-driven)', () => {
  const cases: { title: string; tier: Tier | null }[] = [
    { title: 'Rename getUser to fetchUser across the module please', tier: 'cheap' },
    { title: 'Fix a typo in the README documentation section header text', tier: 'cheap' },
    { title: 'Apply consistent formatting to the utils directory source files', tier: 'cheap' },
    { title: 'Add comments explaining the retry behavior of the scheduler loop', tier: 'cheap' },
    { title: 'Bump version to 2.3.1 ahead of the release tomorrow', tier: 'cheap' },
    { title: 'Add logging to the merge queue worker for observability', tier: 'cheap' },
    { title: 'Refactor the entire authentication subsystem', tier: 'top' },
    { title: 'Propose a new architecture for the ingestion pipeline service', tier: 'top' },
    { title: 'Redesign the settings page information hierarchy and navigation', tier: 'top' },
    { title: 'Debug race condition in the websocket reconnect handler logic', tier: 'top' },
    { title: 'Migrate the storage layer from LevelDB to SQLite backend', tier: 'top' },
    { title: 'Investigate perf regression in the query planner hot path', tier: 'top' },
    // short + trivial verb → cheap
    { title: 'fix the button', tier: 'cheap' },
    // ambiguous → null
    { title: 'Implement dashboard charts for weekly active agents with drilldowns', tier: null },
  ];
  for (const c of cases) {
    it(`"${c.title}" → ${c.tier ?? 'ambiguous'}`, () => {
      const h = heuristicTier(c.title);
      if (c.tier === null) expect(h).toBeNull();
      else expect(h?.tier).toBe(c.tier);
    });
  }
});

describe('clampTier / escalate', () => {
  it('clamps above the ceiling', () => {
    expect(clampTier('max', 'top')).toBe('top');
    expect(clampTier('top', 'cheap')).toBe('cheap');
    expect(clampTier('cheap', 'max')).toBe('cheap');
    expect(clampTier('mid', 'mid')).toBe('mid');
  });

  it('escalates one tier up, null at the cap', () => {
    expect(escalate('cheap', 'max')).toBe('mid');
    expect(escalate('mid', 'max')).toBe('top');
    expect(escalate('top', 'max')).toBe('max');
    expect(escalate('max', 'max')).toBeNull();
    expect(escalate('mid', 'mid')).toBeNull();
    expect(escalate('top', 'mid')).toBeNull();
  });
});

describe('routeTask (no client / no API key)', () => {
  it('override wins over heuristics, by tier name', async () => {
    const d = await routeTask({ ...base, title: 'fix a typo', override: 'top' });
    expect(d.source).toBe('override');
    expect(d.tier).toBe('top');
    expect(d.model).toBe('claude-opus-4-8');
  });

  it('override by model id', async () => {
    const d = await routeTask({ ...base, title: 'whatever this is', override: 'claude-fable-5' });
    expect(d.source).toBe('override');
    expect(d.tier).toBe('max');
  });

  it('override is clamped to maxModel', async () => {
    const d = await routeTask({ ...base, maxModel: 'mid', title: 'x', override: 'max' });
    expect(d.tier).toBe('mid');
    expect(d.reason).toContain('clamped');
  });

  it('heuristic routes without any client', async () => {
    const d = await routeTask({ ...base, title: 'Refactor the entire billing system' });
    expect(d.source).toBe('heuristic');
    expect(d.tier).toBe('top');
  });

  it('heuristic result is clamped to maxModel', async () => {
    const d = await routeTask({ ...base, maxModel: 'mid', title: 'Refactor the entire billing system' });
    expect(d.tier).toBe('mid');
  });

  it('ambiguous title with no client falls back to defaultTier', async () => {
    const d = await routeTask({
      ...base,
      title: 'Implement dashboard charts for weekly active agents with drilldowns',
    });
    expect(d.tier).toBe('mid');
    expect(d.source).toBe('heuristic');
  });
});

describe('routeTask with mock classifier client', () => {
  it('uses the classifier result when confident', async () => {
    const client = {
      complete: async () => JSON.stringify({ tier: 'top', confidence: 0.9, reason: 'cross-cutting change' }),
    };
    const d = await routeTask({
      ...base,
      title: 'Implement dashboard charts for weekly active agents with drilldowns',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
    expect(d.source).toBe('classifier');
    expect(d.tier).toBe('top');
  });

  it('falls back to defaultTier on low confidence', async () => {
    const client = {
      complete: async () => JSON.stringify({ tier: 'top', confidence: 0.2, reason: 'unsure' }),
    };
    const d = await routeTask({
      ...base,
      title: 'Implement dashboard charts for weekly active agents with drilldowns',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
    expect(d.tier).toBe('mid');
  });

  it('falls back to defaultTier when the classifier throws', async () => {
    const client = {
      complete: async () => {
        throw new Error('boom');
      },
    };
    const d = await routeTask({
      ...base,
      title: 'Implement dashboard charts for weekly active agents with drilldowns',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
    expect(d.tier).toBe('mid');
  });
});
