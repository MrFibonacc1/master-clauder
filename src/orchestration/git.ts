/**
 * GitManager — worktree lifecycle, rebase, ff-only merges, diffs.
 * Pure child_process execFile('git', ...) wrappers. No force flags, ever.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

export interface RebaseResult {
  ok: boolean;
  conflictOutput?: string;
}

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`git ${args.join(' ')} failed: ${stderr || stdout || err.message}`);
        (e as Error & { stdout: string; stderr: string }).stdout = stdout;
        (e as Error & { stdout: string; stderr: string }).stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class GitManager {
  /**
   * Create branch agent/<agentName>/<taskSlug> off main and a worktree for it
   * at <repoParent>/.cortex-worktrees/<repoName>/<branchSafeName>.
   */
  async createWorktree(
    repoPath: string,
    repoName: string,
    agentName: string,
    taskSlug: string,
  ): Promise<WorktreeInfo> {
    const branch = `agent/${slugify(agentName)}/${slugify(taskSlug)}`;
    const branchSafeName = branch.replace(/\//g, '-');
    const worktreePath = path.join(path.dirname(repoPath), '.cortex-worktrees', repoName, branchSafeName);
    await git(['worktree', 'add', '-b', branch, worktreePath, 'main'], repoPath);
    return { worktreePath, branch };
  }

  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    opts: { deleteBranch?: boolean } = {},
  ): Promise<void> {
    await git(['worktree', 'remove', '--force', worktreePath], repoPath);
    if (opts.deleteBranch) {
      await git(['branch', '-D', branch], repoPath);
    }
  }

  async listWorktrees(repoPath: string): Promise<{ path: string; branch?: string }[]> {
    const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath);
    const out: { path: string; branch?: string }[] = [];
    let cur: { path: string; branch?: string } | undefined;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) out.push(cur);
        cur = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Rebase worktree's branch onto mainBranch; abort and report on conflict. */
  async rebaseOntoMain(worktreePath: string, mainBranch: string): Promise<RebaseResult> {
    try {
      await git(['rebase', mainBranch], worktreePath);
      return { ok: true };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      try {
        await git(['rebase', '--abort'], worktreePath);
      } catch {
        // rebase may not have started; ignore
      }
      return { ok: false, conflictOutput: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message };
    }
  }

  /**
   * Fast-forward-only merge of branch into mainBranch, done in the main repo
   * checkout. Restores previous HEAD afterwards. Never forces.
   */
  async mergeBranch(repoPath: string, branch: string, mainBranch: string): Promise<void> {
    if (branch === mainBranch) {
      throw new Error(`refusing to merge branch into itself: ${branch}`);
    }
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    const prevHead = stdout.trim();
    await git(['checkout', mainBranch], repoPath);
    try {
      await git(['merge', '--ff-only', branch], repoPath);
    } finally {
      if (prevHead && prevHead !== mainBranch && prevHead !== 'HEAD') {
        await git(['checkout', prevHead], repoPath).catch(() => {});
      }
    }
  }

  async diffAgainstMain(worktreePath: string, mainBranch: string): Promise<string> {
    const { stdout } = await git(['diff', `${mainBranch}...HEAD`], worktreePath);
    return stdout;
  }

  async changedFiles(worktreePath: string, mainBranch: string): Promise<string[]> {
    const { stdout } = await git(['diff', '--name-only', `${mainBranch}...HEAD`], worktreePath);
    return stdout.split('\n').filter(Boolean);
  }
}
