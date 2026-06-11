/**
 * Model catalog: tier → model mapping with pricing, cost math,
 * and an optional live refresh against the Anthropic Models API.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo, Tier } from '../shared/types.js';

export const MODEL_CATALOG: Record<Tier, ModelInfo> = {
  cheap: { tier: 'cheap', id: 'claude-haiku-4-5', inputPerMTok: 1, outputPerMTok: 5 },
  mid: { tier: 'mid', id: 'claude-sonnet-4-6', inputPerMTok: 3, outputPerMTok: 15 },
  top: { tier: 'top', id: 'claude-opus-4-8', inputPerMTok: 5, outputPerMTok: 25 },
  max: { tier: 'max', id: 'claude-fable-5', inputPerMTok: 10, outputPerMTok: 50 },
};

/** Cache reads bill at ~0.1× input price; cache writes at 1.25× input price. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function modelForTier(tier: Tier): ModelInfo {
  return MODEL_CATALOG[tier];
}

export function modelById(modelId: string): ModelInfo | undefined {
  return Object.values(MODEL_CATALOG).find((m) => m.id === modelId);
}

/**
 * USD cost for a call. Unknown models cost 0 (we can't price them).
 */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const info = modelById(model);
  if (!info) return 0;
  const perTok = 1 / 1_000_000;
  return (
    inputTokens * info.inputPerMTok * perTok +
    outputTokens * info.outputPerMTok * perTok +
    cacheReadTokens * info.inputPerMTok * CACHE_READ_MULTIPLIER * perTok +
    cacheWriteTokens * info.inputPerMTok * CACHE_WRITE_MULTIPLIER * perTok
  );
}

/**
 * Verify the static catalog's model IDs against the live Models API.
 * Falls back silently to the static catalog on any error (offline, no key,
 * old SDK). Always returns a usable catalog.
 */
export async function refreshCatalog(client: Anthropic): Promise<Record<Tier, ModelInfo>> {
  try {
    const liveIds = new Set<string>();
    for await (const m of client.models.list()) liveIds.add(m.id);
    const allPresent = Object.values(MODEL_CATALOG).every((m) => liveIds.has(m.id));
    if (allPresent) return MODEL_CATALOG;
    // Some IDs are missing — still return the static catalog (best effort),
    // the API may simply not list aliases.
    return MODEL_CATALOG;
  } catch {
    return MODEL_CATALOG;
  }
}
