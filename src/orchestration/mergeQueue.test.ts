import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationStore } from '../core/store.js';
import { GitManager } from './git.js';
import { MergeQueue } from './mergeQueue.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('MergeQueue', () => {
  let base: string;
  let repo: string;
  let store: CoordinationStore;
  const git = new GitManager();

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'cortex-mq-'));
    repo = path.join(base, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo]);
    sh(repo, ['config', 'user.email', 'test@test.local']);
    sh(repo, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    sh(repo, ['add', '.']);
    sh(repo, ['commit', '-m', 'init']);
    store = new CoordinationStore(path.join(base, 'state.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  async function makeAgentBranch(agentId: string, slug: string, file: string, content: string) {
    const wt = await git.createWorktree(repo, 'repo', agentId, slug);
    writeFileSync(path.join(wt.worktreePath, file), content);
    sh(wt.worktreePath, ['add', '.']);
    sh(wt.worktreePath, ['commit', '-m', `${agentId}: ${slug}`]);
    store.upsertAgent({
      id: agentId,
      name: agentId,
      taskId: `task-${agentId}`,
      repo: 'repo',
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      model: 'claude-haiku-4-5',
      status: 'working',
      startedAt: Date.now(),
    });
    return wt;
  }

  function mq(gateCommand?: string) {
    return new MergeQueue(store, git, { repo: { path: repo, mainBranch: 'main', gateCommand } });
  }

  it('merges two branches touching different files', async () => {
    const wt1 = await makeAgentBranch('a1', 'one', 'one.txt', '1\n');
    const wt2 = await makeAgentBranch('a2', 'two', 'two.txt', '2\n');
    store.submitMerge({ branch: wt1.branch, taskId: 'task-a1', agentId: 'a1', repo: 'repo' });
    store.submitMerge({ branch: wt2.branch, taskId: 'task-a2', agentId: 'a2', repo: 'repo' });

    const queue = mq();
    const r1 = await queue.processNext();
    expect(r1?.status).toBe('merged');
    const r2 = await queue.processNext();
    expect(r2?.status).toBe('merged');

    const log = sh(repo, ['log', 'main', '--oneline']);
    expect(log).toContain('a1: one');
    expect(log).toContain('a2: two');
    expect(await queue.processNext()).toBeUndefined();
  });

  it('marks gate-failed when gateCommand fails', async () => {
    const wt = await makeAgentBranch('a3', 'bad', 'bad.txt', 'x\n');
    store.submitMerge({ branch: wt.branch, taskId: 'task-a3', agentId: 'a3', repo: 'repo' });
    const r = await mq('false').processNext();
    expect(r?.status).toBe('gate-failed');
    const items = store.listMergeQueue();
    expect(items[0].status).toBe('gate-failed');
  });

  it('marks conflict when rebase conflicts', async () => {
    const wt = await makeAgentBranch('a4', 'conf', 'a.txt', 'branch change\n');
    // diverge main on the same file
    writeFileSync(path.join(repo, 'a.txt'), 'main change\n');
    sh(repo, ['commit', '-am', 'main edit']);
    store.submitMerge({ branch: wt.branch, taskId: 'task-a4', agentId: 'a4', repo: 'repo' });

    const r = await mq().processNext();
    expect(r?.status).toBe('conflict');
    expect(r?.gateOutput).toBeTruthy();
  });

  it('detects overlap between queued branches touching the same file', async () => {
    const wt1 = await makeAgentBranch('a5', 'x', 'shared.txt', 'v1\n');
    const wt2 = await makeAgentBranch('a6', 'y', 'shared.txt', 'v2\n');
    const i1 = store.submitMerge({ branch: wt1.branch, taskId: 't', agentId: 'a5', repo: 'repo' });
    const i2 = store.submitMerge({ branch: wt2.branch, taskId: 't', agentId: 'a6', repo: 'repo' });
    const warnings = await mq().detectOverlap([i1, i2]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].files).toEqual(['shared.txt']);
  });
});
