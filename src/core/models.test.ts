import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, costUsd, modelForTier, refreshCatalog } from './models.js';

describe('models', () => {
  it('maps tiers to expected model ids', () => {
    expect(modelForTier('cheap').id).toBe('claude-haiku-4-5');
    expect(modelForTier('mid').id).toBe('claude-sonnet-4-6');
    expect(modelForTier('top').id).toBe('claude-opus-4-8');
    expect(modelForTier('max').id).toBe('claude-fable-5');
  });

  it('computes input/output cost', () => {
    // haiku: $1 in, $5 out per MTok
    expect(costUsd('claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(1, 10);
    expect(costUsd('claude-haiku-4-5', 0, 1_000_000)).toBeCloseTo(5, 10);
    expect(costUsd('claude-sonnet-4-6', 500_000, 100_000)).toBeCloseTo(0.5 * 3 + 0.1 * 15, 10);
  });

  it('prices cache reads at 0.1x and writes at 1.25x input', () => {
    expect(costUsd('claude-haiku-4-5', 0, 0, 1_000_000, 0)).toBeCloseTo(0.1, 10);
    expect(costUsd('claude-haiku-4-5', 0, 0, 0, 1_000_000)).toBeCloseTo(1.25, 10);
    expect(costUsd('claude-fable-5', 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(10 * 0.1 + 10 * 1.25, 10);
  });

  it('returns 0 for unknown models', () => {
    expect(costUsd('not-a-model', 1_000_000, 1_000_000)).toBe(0);
  });

  it('refreshCatalog falls back silently to the static catalog on error', async () => {
    const failingClient = {
      models: {
        list: () => {
          throw new Error('no network');
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(refreshCatalog(failingClient as any)).resolves.toEqual(MODEL_CATALOG);
  });
});
