import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainNote } from '../shared/types.js';
import { Brain, escapeFtsQuery } from './brain.js';

let vault: string;
let brain: Brain;

function note(partial: Partial<BrainNote> & { relPath: string; title: string; body: string }): BrainNote {
  return {
    scope: 'workspace',
    type: 'decision',
    tags: [],
    pinned: false,
    created: new Date().toISOString(),
    links: [],
    ...partial,
  };
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-brain-'));
  brain = new Brain(vault);
});

afterEach(() => {
  brain.close();
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('Brain', () => {
  it('creates the vault structure', () => {
    for (const d of ['workspace', 'repos', 'agents']) {
      expect(fs.existsSync(path.join(vault, d))).toBe(true);
    }
  });

  it('write/read roundtrip preserves frontmatter and extracts wikilinks', () => {
    brain.writeNote(
      note({
        relPath: 'repos/my-app/gotcha-vite.md',
        title: 'Vite node gotcha',
        scope: 'repo',
        repo: 'my-app',
        type: 'gotcha',
        tags: ['vite', 'node'],
        pinned: true,
        created: '2026-01-15T00:00:00.000Z',
        body: 'Vite breaks with [[node-esm]] and see [[my-app]] for context.',
      }),
    );
    const got = brain.readNote('repos/my-app/gotcha-vite.md');
    expect(got.title).toBe('Vite node gotcha');
    expect(got.scope).toBe('repo');
    expect(got.repo).toBe('my-app');
    expect(got.type).toBe('gotcha');
    expect(got.tags).toEqual(['vite', 'node']);
    expect(got.pinned).toBe(true);
    expect(got.links).toEqual(['node-esm', 'my-app']);
    expect(got.body).toContain('Vite breaks');
  });

  it('search finds the relevant note', async () => {
    brain.writeNote(
      note({ relPath: 'workspace/conv.md', title: 'Commit style', body: 'Use conventional commits everywhere.' }),
    );
    brain.writeNote(
      note({ relPath: 'workspace/db.md', title: 'Database choice', body: 'We use SQLite with WAL mode.' }),
    );
    const hits = await brain.search('sqlite wal');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].note.relPath).toBe('workspace/db.md');
  });

  it('pinned notes are boosted', async () => {
    brain.writeNote(
      note({ relPath: 'workspace/a.md', title: 'Testing notes A', body: 'testing guidance for agents', created: '2026-06-01T00:00:00.000Z' }),
    );
    brain.writeNote(
      note({
        relPath: 'workspace/b.md',
        title: 'Testing notes B',
        body: 'testing guidance for agents',
        pinned: true,
        created: '2025-01-01T00:00:00.000Z', // older but pinned
      }),
    );
    const hits = await brain.search('testing guidance');
    expect(hits[0].note.relPath).toBe('workspace/b.md');
  });

  it('reindex picks up manual file edits', async () => {
    brain.writeNote(note({ relPath: 'workspace/x.md', title: 'X', body: 'original wording here' }));
    // edit the file behind the index's back
    const abs = path.join(vault, 'workspace/x.md');
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('original wording', 'zanzibar keyword'));
    await expect(brain.search('zanzibar')).resolves.toHaveLength(0);
    brain.reindex();
    const hits = await brain.search('zanzibar');
    expect(hits).toHaveLength(1);
    expect(hits[0].note.relPath).toBe('workspace/x.md');
  });

  it('retrieveForTask filters to workspace + that repo', async () => {
    brain.writeNote(
      note({ relPath: 'workspace/conv.md', title: 'Conventions', body: 'dark mode toggle conventions' }),
    );
    brain.writeNote(
      note({
        relPath: 'repos/my-app/theme.md',
        title: 'Theme system',
        scope: 'repo',
        repo: 'my-app',
        body: 'dark mode is implemented via CSS variables',
      }),
    );
    brain.writeNote(
      note({
        relPath: 'repos/other-app/theme.md',
        title: 'Other theme',
        scope: 'repo',
        repo: 'other-app',
        body: 'dark mode handled by a sass mixin',
      }),
    );
    const { hits, renderContext } = await brain.retrieveForTask('add dark mode toggle', 'my-app');
    const paths = hits.map((h) => h.note.relPath);
    expect(paths).toContain('repos/my-app/theme.md');
    expect(paths).toContain('workspace/conv.md');
    expect(paths).not.toContain('repos/other-app/theme.md');
    expect(renderContext(hits).startsWith('# Relevant memory')).toBe(true);
  });

  it('renderContext produces a bounded markdown block', async () => {
    brain.writeNote(note({ relPath: 'workspace/big.md', title: 'Big', body: 'lorem '.repeat(2000) }));
    const hits = await brain.search('lorem');
    const ctx = brain.renderContext(hits);
    expect(ctx.startsWith('# Relevant memory')).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual(4000);
  });

  it('deleteNote removes file and index entry', async () => {
    brain.writeNote(note({ relPath: 'workspace/del.md', title: 'Del', body: 'ephemeral flamingo content' }));
    await expect(brain.search('flamingo')).resolves.toHaveLength(1);
    brain.deleteNote('workspace/del.md');
    expect(fs.existsSync(path.join(vault, 'workspace/del.md'))).toBe(false);
    await expect(brain.search('flamingo')).resolves.toHaveLength(0);
  });

  it('pinNote toggles the pinned flag on disk', () => {
    brain.writeNote(note({ relPath: 'workspace/p.md', title: 'P', body: 'pin me' }));
    brain.pinNote('workspace/p.md', true);
    expect(brain.readNote('workspace/p.md').pinned).toBe(true);
  });

  it('taskLog writes a repo-scoped note with a wikilink', () => {
    const n = brain.taskLog('my-app', 'Add dark mode', 'done', 'Implemented via CSS vars.');
    expect(n.relPath.startsWith('repos/my-app/task-log-add-dark-mode')).toBe(true);
    const got = brain.readNote(n.relPath);
    expect(got.type).toBe('task-log');
    expect(got.repo).toBe('my-app');
    expect(got.links).toContain('my-app');
  });

  it('escapes FTS5 queries safely', async () => {
    expect(escapeFtsQuery('hello "world" AND')).toBe('"hello" OR "world" OR "AND"');
    expect(escapeFtsQuery('   ')).toBe('');
    // malicious-ish input must not throw
    await expect(brain.search('NEAR( " OR drop)')).resolves.toBeDefined();
  });
});
