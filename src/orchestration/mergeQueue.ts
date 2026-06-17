/**
 * MergeQueue — the only writer to main. Serially: rebase onto main, run the
 * gate command, fast-forward merge. Conflicts and red gates bounce back.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { CoordinationStore } from '../core/store.js';
import type { GitManager } from './git.js';
import type { MergeItem } from '../shared/types.js';

export interface MergeRepoConfig {
  path: string;
  mainBranch?: string; // defaults to 'main'
  gateCommand?: string;
}

export interface OverlapWarning {
  branchA: string;
  branchB: string;
  files: string[];
}

const GATE_TIMEOUT_MS = 10 * 60 * 1000;

function runGate(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      { cwd, timeout: GATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim() });
      },
    );
  });
}

export class MergeQueue {
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private store: CoordinationStore,
    private git: GitManager,
    private repos: Record<string, MergeRepoConfig>,
  ) {}

  /** Process the next queued merge item, if any. Returns the item's final state or undefined if queue empty. */
  async processNext(): Promise<MergeItem | undefined> {
    const item = this.store.nextQueuedMerge();
    if (!item) return undefined;
    const repo = this.repos[item.repo];
    if (!repo) {
      this.store.setMergeStatus(item.id, 'gate-failed', `unknown repo: ${item.repo}`);
      return { ...item, status: 'gate-failed' };
    }

    const mainBranch = repo.mainBranch ?? 'main';
    const agent = this.store.getAgent(item.agentId);
    const worktreePath =
      agent?.worktreePath ??
      path.join(path.dirname(repo.path), '.cortex-worktrees', item.repo, item.branch.replace(/\//g, '-'));

    // 1) rebase onto main
    this.store.setMergeStatus(item.id, 'rebasing');
    const rebase = await this.git.rebaseOntoMain(worktreePath, mainBranch);
    if (!rebase.ok) {
      this.store.setMergeStatus(item.id, 'conflict', rebase.conflictOutput);
      return { ...item, status: 'conflict', gateOutput: rebase.conflictOutput };
    }

    // 2) gate
    if (repo.gateCommand) {
      this.store.setMergeStatus(item.id, 'testing');
      const gate = await runGate(repo.gateCommand, worktreePath);
      if (!gate.ok) {
        this.store.setMergeStatus(item.id, 'gate-failed', gate.output);
        return { ...item, status: 'gate-failed', gateOutput: gate.output };
      }
    }

    // 3) ff-only merge
    try {
      await this.git.mergeBranch(repo.path, item.branch, mainBranch);
      this.store.setMergeStatus(item.id, 'merged');
      // Clean up the now-merged worktree + branch (best-effort; never fail the merge).
      try {
        await this.git.removeWorktree(repo.path, worktreePath, item.branch, { deleteBranch: true });
      } catch {
        /* worktree/branch cleanup is best-effort */
      }
      return { ...item, status: 'merged' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.setMergeStatus(item.id, 'conflict', msg);
      return { ...item, status: 'conflict', gateOutput: msg };
    }
  }

  /** Pairwise compare changed files of queued branches; warn on overlap. */
  async detectOverlap(queuedItems: MergeItem[]): Promise<OverlapWarning[]> {
    const warnings: OverlapWarning[] = [];
    const fileSets: { item: MergeItem; files: string[] }[] = [];
    for (const item of queuedItems) {
      const repo = this.repos[item.repo];
      if (!repo) continue;
      const agent = this.store.getAgent(item.agentId);
      if (!agent?.worktreePath) continue;
      try {
        fileSets.push({ item, files: await this.git.changedFiles(agent.worktreePath, repo.mainBranch ?? 'main') });
      } catch {
        // worktree gone; skip
      }
    }
    for (let i = 0; i < fileSets.length; i++) {
      for (let j = i + 1; j < fileSets.length; j++) {
        const setB = new Set(fileSets[j].files);
        const shared = fileSets[i].files.filter((f) => setB.has(f));
        if (shared.length > 0) {
          warnings.push({ branchA: fileSets[i].item.branch, branchB: fileSets[j].item.branch, files: shared });
        }
      }
    }
    return warnings;
  }

  run(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.processing) return;
      this.processing = true;
      void this.processNext().finally(() => {
        this.processing = false;
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
