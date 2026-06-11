import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationStore, globsMayOverlap } from '../core/store.js';
import { Orchestrator, digestRecentEvents, fixOverlappingOwnership, needsPlanning, type ModelClientLike } from './orchestrator.js';

function fakeClient(json: unknown): ModelClientLike {
  return { complete: async () => JSON.stringify(json) };
}

describe('Orchestrator.plan', () => {
  let base: string;
  let store: CoordinationStore;

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'cortex-orch-'));
    store = new CoordinationStore(path.join(base, 'state.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('returns a validated plan from canned planner JSON', async () => {
    const orch = new Orchestrator({
      store,
      modelClientLike: fakeClient({
        subtasks: [
          { title: 'api', prompt: 'do api', ownership: ['src/api/**'], suggestedTier: 'mid' },
          { title: 'ui', prompt: 'do ui', ownership: ['src/ui/**'], suggestedTier: 'cheap' },
        ],
        notes: 'split by layer',
      }),
      plannerModel: 'claude-opus-4-8',
    });
    const plan = await orch.plan({ id: 't1', title: 'big task', repo: 'repo' }, '');
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.notes).toBe('split by layer');
    expect(plan.subtasks[0].ownership).toEqual(['src/api/**']);
  });

  it('fixes overlapping globs deterministically without a second model call', async () => {
    let calls = 0;
    const client: ModelClientLike = {
      complete: async () => {
        calls++;
        return JSON.stringify({
          subtasks: [
            { title: 'a', prompt: 'pa', ownership: ['src/**'], suggestedTier: 'mid' },
            { title: 'b', prompt: 'pb', ownership: ['src/ui/**'], suggestedTier: 'mid' },
          ],
        });
      },
    };
    const orch = new Orchestrator({ store, modelClientLike: client, plannerModel: 'm' });
    const plan = await orch.plan({ id: 't2', title: 'overlapping', repo: 'repo' }, '');
    expect(calls).toBe(1);
    const [a, b] = plan.subtasks;
    for (const ga of a.ownership) {
      for (const gb of b.ownership) {
        expect(globsMayOverlap(ga, gb)).toBe(false);
      }
    }
  });

  it('rejects invalid planner output', async () => {
    const orch = new Orchestrator({ store, modelClientLike: fakeClient({ subtasks: [] }), plannerModel: 'm' });
    await expect(orch.plan({ id: 't3', title: 'x', repo: 'repo' }, '')).rejects.toThrow(/no subtasks/);
  });

  it('coerces an unknown suggestedTier to mid', async () => {
    const orch = new Orchestrator({
      store,
      modelClientLike: fakeClient({
        subtasks: [{ title: 'a', prompt: 'p', ownership: ['x/**'], suggestedTier: 'mega' }],
      }),
      plannerModel: 'm',
    });
    const plan = await orch.plan({ id: 't4', title: 'x', repo: 'repo' }, '');
    expect(plan.subtasks[0].suggestedTier).toBe('mid');
  });

  it('digestRecentEvents produces a compact digest', () => {
    store.append({ ts: Date.now(), type: 'agent.status', agentId: 'a1', payload: { status: 'working' } });
    store.append({ ts: Date.now(), type: 'merge.submitted', agentId: 'a1', payload: { branch: 'agent/a1/x' } });
    const digest = digestRecentEvents(store, 'repo', 20);
    expect(digest).toContain('[a1] status: working');
    expect(digest).toContain('submitted branch agent/a1/x');
  });
});

describe('fixOverlappingOwnership', () => {
  it('leaves disjoint globs untouched', () => {
    const subtasks = [
      { title: 'a', prompt: 'p', ownership: ['src/a/**'], suggestedTier: 'mid' as const },
      { title: 'b', prompt: 'p', ownership: ['src/b/**'], suggestedTier: 'mid' as const },
    ];
    expect(fixOverlappingOwnership(subtasks)).toEqual(subtasks);
  });

  it('prefixes all subtasks when any pair overlaps', () => {
    const fixed = fixOverlappingOwnership([
      { title: 'a', prompt: 'p', ownership: ['src/**'], suggestedTier: 'mid' },
      { title: 'b', prompt: 'p', ownership: ['src/x/**'], suggestedTier: 'mid' },
    ]);
    expect(fixed[0].ownership[0]).toBe('subtask-0/src/**');
    expect(fixed[1].ownership[0]).toBe('subtask-1/src/x/**');
  });
});

describe('needsPlanning', () => {
  it('flags multi-part and big tasks', () => {
    expect(needsPlanning('add dark mode, update settings page, and write docs')).toBe(true);
    expect(needsPlanning('refactor the auth layer')).toBe(true);
    expect(
      needsPlanning('please go through every page in the app and make sure all of the headings use the new font'),
    ).toBe(true);
  });

  it('skips simple tasks', () => {
    expect(needsPlanning('fix typo in README')).toBe(false);
    expect(needsPlanning('rename variable foo to bar')).toBe(false);
  });
});
