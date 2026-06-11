/**
 * Brain — the Obsidian-vault memory. Markdown notes with YAML frontmatter are
 * the source of truth; a SQLite FTS5 index at <vault>/index.db is derived and
 * fully rebuildable via reindex().
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import chokidar from 'chokidar';
import matter from 'gray-matter';
import type { BrainNote, MemoryHit, NoteScope, NoteType } from '../shared/types.js';

const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  rel_path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  repo TEXT,
  agent TEXT,
  type TEXT NOT NULL,
  tags TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(rel_path UNINDEXED, title, body, tags);
`;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

export interface SearchOptions {
  scope?: NoteScope;
  repo?: string;
  agent?: string;
  k?: number;
}

export class Brain {
  private db: Database.Database;

  constructor(readonly vaultPath: string) {
    this.ensureVault();
    this.db = new Database(path.join(vaultPath, 'index.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(INDEX_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  ensureVault(): void {
    for (const dir of ['workspace', 'repos', 'agents']) {
      fs.mkdirSync(path.join(this.vaultPath, dir), { recursive: true });
    }
  }

  // ---- notes (filesystem) ----

  writeNote(note: BrainNote): void {
    const abs = this.absPath(note.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fm: Record<string, unknown> = {
      title: note.title,
      scope: note.scope,
      type: note.type,
      tags: note.tags,
      pinned: note.pinned,
      created: note.created,
    };
    if (note.repo) fm.repo = note.repo;
    if (note.agent) fm.agent = note.agent;
    fs.writeFileSync(abs, matter.stringify(note.body, fm));
    this.indexNote(note.relPath);
  }

  readNote(relPath: string): BrainNote {
    const raw = fs.readFileSync(this.absPath(relPath), 'utf8');
    const { data, content } = matter(raw);
    const links: string[] = [];
    for (const m of content.matchAll(WIKILINK_RE)) links.push(m[1].trim());
    return {
      relPath,
      title: (data.title as string) ?? path.basename(relPath, '.md'),
      scope: (data.scope as NoteScope) ?? 'workspace',
      repo: (data.repo as string) ?? undefined,
      agent: (data.agent as string) ?? undefined,
      type: (data.type as NoteType) ?? 'task-log',
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
      pinned: Boolean(data.pinned),
      created: data.created ? String(data.created) : new Date().toISOString(),
      body: content,
      links,
    };
  }

  listNotes(filter?: { scope?: NoteScope; repo?: string; agent?: string; type?: NoteType }): BrainNote[] {
    const out: BrainNote[] = [];
    for (const relPath of this.walkMd(this.vaultPath)) {
      let note: BrainNote;
      try {
        note = this.readNote(relPath);
      } catch {
        continue;
      }
      if (filter?.scope && note.scope !== filter.scope) continue;
      if (filter?.repo && note.repo !== filter.repo) continue;
      if (filter?.agent && note.agent !== filter.agent) continue;
      if (filter?.type && note.type !== filter.type) continue;
      out.push(note);
    }
    return out;
  }

  deleteNote(relPath: string): void {
    fs.rmSync(this.absPath(relPath), { force: true });
    this.removeFromIndex(relPath);
  }

  pinNote(relPath: string, pinned: boolean): void {
    const note = this.readNote(relPath);
    note.pinned = pinned;
    this.writeNote(note);
  }

  // ---- index (SQLite + FTS5) ----

  indexNote(relPath: string): void {
    let note: BrainNote;
    try {
      note = this.readNote(relPath);
    } catch {
      return;
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM notes WHERE rel_path=?`).run(relPath);
      this.db.prepare(`DELETE FROM notes_fts WHERE rel_path=?`).run(relPath);
      this.db
        .prepare(
          `INSERT INTO notes (rel_path, title, scope, repo, agent, type, tags, pinned, created, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relPath,
          note.title,
          note.scope,
          note.repo ?? null,
          note.agent ?? null,
          note.type,
          note.tags.join(','),
          note.pinned ? 1 : 0,
          note.created,
          note.body,
        );
      this.db
        .prepare(`INSERT INTO notes_fts (rel_path, title, body, tags) VALUES (?, ?, ?, ?)`)
        .run(relPath, note.title, note.body, note.tags.join(' '));
    });
    tx();
  }

  removeFromIndex(relPath: string): void {
    this.db.prepare(`DELETE FROM notes WHERE rel_path=?`).run(relPath);
    this.db.prepare(`DELETE FROM notes_fts WHERE rel_path=?`).run(relPath);
  }

  reindex(): void {
    this.db.exec(`DELETE FROM notes; DELETE FROM notes_fts;`);
    for (const relPath of this.walkMd(this.vaultPath)) this.indexNote(relPath);
  }

  // ---- search ----

  /**
   * FTS5 search scored by bm25 + recency boost + pinned boost.
   *
   * EMBEDDING SEAM: to add semantic scoring later, compute an embedding
   * similarity for each candidate here and blend it into `score` (e.g.
   * score += embedSim * weight). The candidate set and the MemoryHit shape
   * stay the same.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<MemoryHit[]> {
    const match = escapeFtsQuery(query);
    if (!match) return [];
    const k = opts.k ?? 6;

    const conditions: string[] = [];
    const params: unknown[] = [match];
    if (opts.scope) {
      conditions.push(`n.scope = ?`);
      params.push(opts.scope);
    }
    if (opts.repo) {
      conditions.push(`(n.repo = ? OR n.scope = 'workspace')`);
      params.push(opts.repo);
    }
    if (opts.agent) {
      conditions.push(`n.agent = ?`);
      params.push(opts.agent);
    }
    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT n.rel_path AS relPath, n.pinned AS pinned, n.created AS created,
                bm25(notes_fts) AS rank
         FROM notes_fts f JOIN notes n ON n.rel_path = f.rel_path
         WHERE notes_fts MATCH ? ${where}
         ORDER BY rank`,
      )
      .all(...params) as { relPath: string; pinned: number; created: string; rank: number }[];

    const now = Date.now();
    const hits: MemoryHit[] = [];
    for (const r of rows) {
      let note: BrainNote;
      try {
        note = this.readNote(r.relPath);
      } catch {
        continue;
      }
      const ageDays = Math.max(0, (now - Date.parse(r.created)) / 86_400_000) || 0;
      const recencyBoost = 1 / (1 + ageDays / 30); // newer → closer to 1
      const pinnedBoost = r.pinned ? 2 : 0;
      const score = -r.rank + recencyBoost + pinnedBoost; // bm25 is lower-is-better
      hits.push({ note, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /**
   * Workspace + repo scoped retrieval for prompt injection. Returns the hits
   * plus a renderContext helper producing a compact markdown block.
   */
  async retrieveForTask(
    taskTitle: string,
    repoName: string,
    k = 6,
  ): Promise<{ hits: MemoryHit[]; renderContext: (hits: MemoryHit[]) => string }> {
    const hits = await this.search(taskTitle, { repo: repoName, k });
    return { hits, renderContext: (h) => this.renderContext(h) };
  }

  /** Compact markdown block for prompt injection, ~4000 chars max. */
  renderContext(hits: MemoryHit[]): string {
    const MAX = 4000;
    let out = '# Relevant memory\n';
    for (const { note } of hits) {
      const section = `\n## ${note.title}${note.pinned ? ' (pinned)' : ''} — ${note.relPath}\n${note.body.trim()}\n`;
      if (out.length + section.length > MAX) {
        const remaining = MAX - out.length;
        if (remaining > 80) out += `${section.slice(0, remaining - 4)}\n…\n`;
        break;
      }
      out += section;
    }
    return out;
  }

  // ---- watcher ----

  /** Incremental reindex on vault file changes. Returns a close function. */
  watch(): () => Promise<void> {
    const watcher = chokidar.watch(this.vaultPath, {
      ignored: (p) => path.basename(p).startsWith('index.db'),
      ignoreInitial: true,
    });
    const rel = (p: string) => path.relative(this.vaultPath, p);
    const onUpsert = (p: string) => {
      if (p.endsWith('.md')) this.indexNote(rel(p));
    };
    watcher.on('add', onUpsert);
    watcher.on('change', onUpsert);
    watcher.on('unlink', (p) => {
      if (p.endsWith('.md')) this.removeFromIndex(rel(p));
    });
    return () => watcher.close();
  }

  // ---- conveniences ----

  /** Write a task-log note under repos/<repo>/, wikilinked to the repo note. */
  taskLog(repoName: string, taskTitle: string, outcome: string, details: string): BrainNote {
    const slug = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const note: BrainNote = {
      relPath: path.posix.join('repos', repoName, `task-log-${slug}-${Date.now()}.md`),
      title: `Task log: ${taskTitle}`,
      scope: 'repo',
      repo: repoName,
      type: 'task-log',
      tags: ['task-log', outcome],
      pinned: false,
      created: new Date().toISOString(),
      body: `Outcome: **${outcome}** for [[${repoName}]]\n\n${details}\n`,
      links: [repoName],
    };
    this.writeNote(note);
    return note;
  }

  // ---- helpers ----

  private absPath(relPath: string): string {
    const abs = path.resolve(this.vaultPath, relPath);
    if (!abs.startsWith(path.resolve(this.vaultPath))) {
      throw new Error(`Note path escapes vault: ${relPath}`);
    }
    return abs;
  }

  private *walkMd(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) yield* this.walkMd(abs);
      else if (e.isFile() && e.name.endsWith('.md')) yield path.relative(this.vaultPath, abs);
    }
  }
}

/** Escape an arbitrary query for FTS5 MATCH: quote each term, OR-joined. */
export function escapeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean);
  return terms.map((t) => `"${t}"`).join(' OR ');
}
