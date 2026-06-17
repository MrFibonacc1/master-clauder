/**
 * Config loading/saving. Global config at ~/.cortex/config.json,
 * per-repo overrides in <repo>/.cortex.json.
 * API keys are NEVER persisted — env var ANTHROPIC_API_KEY only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CortexConfig, RepoConfig } from '../shared/types.js';

export const CORTEX_HOME = process.env.CORTEX_HOME ?? path.join(os.homedir(), '.cortex');

const DEFAULTS: CortexConfig = {
  vaultPath: path.join(CORTEX_HOME, 'brain'),
  maxModel: 'top',
  defaultTier: 'mid',
  autonomy: 'standard',
  reviewBeforeMerge: false,
  idleStallMs: 90_000,
  concurrency: 5,
  dashboardPort: 4242,
  budget: { perTaskUsd: 5, perDayUsd: 25, warnRatio: 0.8 },
  repos: {},
};

const KEY_PATTERN = /sk-ant-[A-Za-z0-9-_]{10,}/;

export function configPath(): string {
  return path.join(CORTEX_HOME, 'config.json');
}

export function loadConfig(): CortexConfig {
  ensureHome();
  const p = configPath();
  if (!fs.existsSync(p)) return structuredClone(DEFAULTS);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ...structuredClone(DEFAULTS), ...raw, budget: { ...DEFAULTS.budget, ...(raw.budget ?? {}) } };
}

export function saveConfig(cfg: CortexConfig): void {
  ensureHome();
  const json = JSON.stringify(cfg, null, 2);
  if (KEY_PATTERN.test(json)) {
    throw new Error('Refusing to persist config: contains what looks like an API key. Use ANTHROPIC_API_KEY env var.');
  }
  fs.writeFileSync(configPath(), json);
}

/** Effective repo config: global entry merged with <repo>/.cortex.json if present. */
export function repoConfig(cfg: CortexConfig, repoName: string): RepoConfig | undefined {
  const base = cfg.repos[repoName];
  if (!base) return undefined;
  const localPath = path.join(base.path, '.cortex.json');
  if (fs.existsSync(localPath)) {
    try {
      return { ...base, ...JSON.parse(fs.readFileSync(localPath, 'utf8')), name: base.name, path: base.path };
    } catch {
      return base;
    }
  }
  return base;
}

export function registerRepo(cfg: CortexConfig, repoPath: string, opts: Partial<RepoConfig> = {}): RepoConfig {
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(path.join(abs, '.git'))) throw new Error(`${abs} is not a git repository`);
  const name = opts.name ?? path.basename(abs);
  const rc: RepoConfig = { name, path: abs, mainBranch: 'main', ...opts };
  cfg.repos[name] = rc;
  saveConfig(cfg);
  return rc;
}

export function ensureHome(): void {
  fs.mkdirSync(CORTEX_HOME, { recursive: true });
  fs.mkdirSync(path.join(CORTEX_HOME, 'logs'), { recursive: true });
}

export function statePath(): string {
  return path.join(CORTEX_HOME, 'state.db');
}
