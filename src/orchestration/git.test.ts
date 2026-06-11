import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitManager } from './git.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(base: string): string {
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  sh(repo, ['config', 'user.email', 'test@test.local']);
  sh(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-m', 'init']);
  return repo;
}

describe('GitManager', () => {
  let base: string;
  let repo: string;
  const git = new GitManager();

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'cortex-git-'));
    repo = makeRepo(base);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates a worktree on a new agent branch', async () => {
    const wt = await git.createWorktree(repo, 'repo', 'alice', 'Add Dark Mode');
    expect(wt.branch).toBe('agent/alice/add-dark-mode');
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(wt.worktreePath).toContain('.cortex-worktrees');
    const branches = sh(repo, ['branch', '--list', wt.branch]);
    expect(branches).toContain(wt.branch);
    const wts = await git.listWorktrees(repo);
    expect(wts.some((w) => w.branch === wt.branch)).toBe(true);
  });

  it('rebases cleanly and ff-merges into main', async () => {
    const wt = await git.createWorktree(repo, 'repo', 'alice', 'feature');
    writeFileSync(path.join(wt.worktreePath, 'b.txt'), 'new file\n');
    sh(wt.worktreePath, ['add', '.']);
    sh(wt.worktreePath, ['commit', '-m', 'add b']);

    const rebase = await git.rebaseOntoMain(wt.worktreePath, 'main');
    expect(rebase.ok).toBe(true);

    const files = await git.changedFiles(wt.worktreePath, 'main');
    expect(files).toEqual(['b.txt']);
    const diff = await git.diffAgainstMain(wt.worktreePath, 'main');
    expect(diff).toContain('new file');

    await git.mergeBranch(repo, wt.branch, 'main');
    const log = sh(repo, ['log', 'main', '--oneline']);
    expect(log).toContain('add b');
  });

  it('returns ok:false with output on rebase conflict', async () => {
    const wt = await git.createWorktree(repo, 'repo', 'bob', 'conflict');
    // diverge: change a.txt on both main and the branch
    writeFileSync(path.join(repo, 'a.txt'), 'main change\n');
    sh(repo, ['commit', '-am', 'main edit']);
    writeFileSync(path.join(wt.worktreePath, 'a.txt'), 'branch change\n');
    sh(wt.worktreePath, ['commit', '-am', 'branch edit']);

    const rebase = await git.rebaseOntoMain(wt.worktreePath, 'main');
    expect(rebase.ok).toBe(false);
    expect(rebase.conflictOutput).toBeTruthy();
    // rebase was aborted — worktree is back on its branch
    const head = sh(wt.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    expect(head).toBe(wt.branch);
  });

  it('refuses to merge a branch into itself', async () => {
    await expect(git.mergeBranch(repo, 'main', 'main')).rejects.toThrow(/refusing/);
  });

  it('removes worktree and optionally deletes the branch', async () => {
    const wt = await git.createWorktree(repo, 'repo', 'carol', 'cleanup');
    await git.removeWorktree(repo, wt.worktreePath, wt.branch, { deleteBranch: true });
    expect(existsSync(wt.worktreePath)).toBe(false);
    const branches = sh(repo, ['branch', '--list', wt.branch]);
    expect(branches.trim()).toBe('');
  });
});
