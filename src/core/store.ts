/**
 * CoordinationStore — SQLite-backed shared state: task board, claims,
 * event log, routing decisions, usage/cost, merge queue, parked reviews.
 * Single writer (the hub process). All reads are synchronous (better-sqlite3).
 */
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type {
  AgentRecord,
  Claim,
  CortexEvent,
  MergeItem,
  MergeStatus,
  NewEvent,
  RoutingDecision,
  TaskRecord,
  TaskStatus,
  Usage,
} from '../shared/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL,
  status TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
  repo TEXT NOT NULL, owner_agent TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, task_id TEXT NOT NULL,
  repo TEXT NOT NULL, worktree_path TEXT, branch TEXT, model TEXT NOT NULL,
  status TEXT NOT NULL, sdk_session_id TEXT, pid INTEGER, started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL, repo TEXT NOT NULL, path_glob TEXT NOT NULL,
  acquired_at INTEGER NOT NULL, released_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, type TEXT NOT NULL,
  agent_id TEXT, task_id TEXT, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routing_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, tier TEXT NOT NULL, model TEXT NOT NULL,
  reason TEXT NOT NULL, source TEXT NOT NULL, est_cost REAL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, agent_id TEXT, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS merge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  repo TEXT NOT NULL, status TEXT NOT NULL, gate_output TEXT, submitted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  agent_id TEXT PRIMARY KEY, data TEXT NOT NULL, parked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
`;

export class CoordinationStore extends EventEmitter {
  private db: Database.Database;

  constructor(dbPath: string) {
    super();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- tasks ----
  upsertTask(t: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, parent_id, title, status, tier, model, repo, owner_agent, created_at, updated_at)
         VALUES (@id, @parentId, @title, @status, @tier, @model, @repo, @ownerAgent, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET status=@status, tier=@tier, model=@model, owner_agent=@ownerAgent, updated_at=@updatedAt`,
      )
      .run({ parentId: null, ownerAgent: null, ...t });
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`).run(status, Date.now(), id);
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return r ? rowToTask(r) : undefined;
  }

  listTasks(status?: TaskStatus): TaskRecord[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM tasks WHERE status=? ORDER BY created_at DESC`).all(status)
        : this.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all()
    ) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  // ---- agents ----
  upsertAgent(a: AgentRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, task_id, repo, worktree_path, branch, model, status, sdk_session_id, pid, started_at)
         VALUES (@id, @name, @taskId, @repo, @worktreePath, @branch, @model, @status, @sdkSessionId, @pid, @startedAt)
         ON CONFLICT(id) DO UPDATE SET status=@status, worktree_path=@worktreePath, branch=@branch,
           sdk_session_id=@sdkSessionId, pid=@pid`,
      )
      .run({ worktreePath: null, branch: null, sdkSessionId: null, pid: null, ...a });
  }

  getAgent(id: string): AgentRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return r ? rowToAgent(r) : undefined;
  }

  listAgents(activeOnly = false): AgentRecord[] {
    const rows = (
      activeOnly
        ? this.db
            .prepare(`SELECT * FROM agents WHERE status IN ('starting','working','blocked','paused') ORDER BY started_at`)
            .all()
        : this.db.prepare(`SELECT * FROM agents ORDER BY started_at DESC`).all()
    ) as Record<string, unknown>[];
    return rows.map(rowToAgent);
  }

  // ---- claims (path locks) ----
  /** Returns false (and acquires nothing) if any glob overlaps an active claim by another agent. */
  tryAcquireClaims(agentId: string, repo: string, globs: string[]): boolean {
    const active = this.activeClaims(repo).filter((c) => c.agentId !== agentId);
    for (const g of globs) {
      if (active.some((c) => globsMayOverlap(c.pathGlob, g))) return false;
    }
    const ins = this.db.prepare(
      `INSERT INTO claims (agent_id, repo, path_glob, acquired_at) VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const g of globs) ins.run(agentId, repo, g, Date.now());
    });
    tx();
    this.append({ ts: Date.now(), type: 'claim.acquired', agentId, payload: { repo, globs } });
    return true;
  }

  releaseClaims(agentId: string): void {
    this.db.prepare(`UPDATE claims SET released_at=? WHERE agent_id=? AND released_at IS NULL`).run(Date.now(), agentId);
    this.append({ ts: Date.now(), type: 'claim.released', agentId, payload: {} });
  }

  activeClaims(repo?: string): Claim[] {
    const rows = (
      repo
        ? this.db.prepare(`SELECT * FROM claims WHERE released_at IS NULL AND repo=?`).all(repo)
        : this.db.prepare(`SELECT * FROM claims WHERE released_at IS NULL`).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      agentId: r.agent_id as string,
      repo: r.repo as string,
      pathGlob: r.path_glob as string,
      acquiredAt: r.acquired_at as number,
      releasedAt: (r.released_at as number) ?? undefined,
    }));
  }

  // ---- events ----
  /** Append an event; emits 'event' for live subscribers (WS, REPL). */
  append(e: NewEvent): CortexEvent {
    const info = this.db
      .prepare(`INSERT INTO events (ts, type, agent_id, task_id, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(e.ts, e.type, e.agentId ?? null, e.taskId ?? null, JSON.stringify(e.payload));
    const full: CortexEvent = { id: Number(info.lastInsertRowid), ...e };
    this.emit('event', full);
    return full;
  }

  eventsSince(id: number, limit = 500): CortexEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?`)
      .all(id, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      type: r.type as CortexEvent['type'],
      agentId: (r.agent_id as string) ?? undefined,
      taskId: (r.task_id as string) ?? undefined,
      payload: JSON.parse(r.payload as string),
    }));
  }

  // ---- routing & usage ----
  recordRouting(d: RoutingDecision): void {
    this.db
      .prepare(
        `INSERT INTO routing_decisions (task_id, tier, model, reason, source, est_cost, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.taskId, d.tier, d.model, d.reason, d.source, d.estCostUsd ?? null, d.ts);
  }

  recordUsage(u: Usage): void {
    this.db
      .prepare(
        `INSERT INTO usage (task_id, agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.taskId, u.agentId ?? null, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.costUsd, u.ts);
  }

  costForTask(taskId: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM usage WHERE task_id=?`).get(taskId) as { c: number };
    return r.c;
  }

  costForDay(dayStartTs: number): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd),0) c FROM usage WHERE ts >= ?`).get(dayStartTs) as { c: number };
    return r.c;
  }

  costSummary(): { byTask: Record<string, number>; byAgent: Record<string, number>; total: number } {
    const byTask: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    let total = 0;
    for (const r of this.db
      .prepare(`SELECT task_id, agent_id, SUM(cost_usd) c FROM usage GROUP BY task_id, agent_id`)
      .all() as { task_id: string; agent_id: string | null; c: number }[]) {
      byTask[r.task_id] = (byTask[r.task_id] ?? 0) + r.c;
      if (r.agent_id) byAgent[r.agent_id] = (byAgent[r.agent_id] ?? 0) + r.c;
      total += r.c;
    }
    return { byTask, byAgent, total };
  }

  // ---- merge queue ----
  submitMerge(item: Omit<MergeItem, 'id' | 'status' | 'submittedAt'>): MergeItem {
    const ts = Date.now();
    const info = this.db
      .prepare(`INSERT INTO merge_queue (branch, task_id, agent_id, repo, status, submitted_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
      .run(item.branch, item.taskId, item.agentId, item.repo, ts);
    this.append({ ts, type: 'merge.submitted', agentId: item.agentId, taskId: item.taskId, payload: { branch: item.branch } });
    return { id: Number(info.lastInsertRowid), status: 'queued', submittedAt: ts, ...item };
  }

  nextQueuedMerge(repo?: string): MergeItem | undefined {
    const r = (
      repo
        ? this.db.prepare(`SELECT * FROM merge_queue WHERE status='queued' AND repo=? ORDER BY id LIMIT 1`).get(repo)
        : this.db.prepare(`SELECT * FROM merge_queue WHERE status='queued' ORDER BY id LIMIT 1`).get()
    ) as Record<string, unknown> | undefined;
    return r ? rowToMerge(r) : undefined;
  }

  setMergeStatus(id: number, status: MergeStatus, gateOutput?: string): void {
    this.db.prepare(`UPDATE merge_queue SET status=?, gate_output=? WHERE id=?`).run(status, gateOutput ?? null, id);
    const r = this.db.prepare(`SELECT * FROM merge_queue WHERE id=?`).get(id) as Record<string, unknown>;
    const item = rowToMerge(r);
    this.append({
      ts: Date.now(),
      type: 'merge.result',
      agentId: item.agentId,
      taskId: item.taskId,
      payload: { branch: item.branch, status, gateOutput: gateOutput?.slice(0, 2000) },
    });
  }

  listMergeQueue(): MergeItem[] {
    const rows = this.db.prepare(`SELECT * FROM merge_queue ORDER BY id DESC LIMIT 100`).all() as Record<string, unknown>[];
    return rows.map(rowToMerge);
  }

  // ---- reviews (parked agents awaiting human review; durable + cross-process) ----
  saveReview(agentId: string, data: Record<string, unknown>): void {
    this.db
      .prepare(`INSERT INTO reviews (agent_id, data, parked_at) VALUES (?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data, parked_at=excluded.parked_at`)
      .run(agentId, JSON.stringify(data), Date.now());
  }

  getReview(agentId: string): Record<string, unknown> | undefined {
    const r = this.db.prepare(`SELECT data FROM reviews WHERE agent_id=?`).get(agentId) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Record<string, unknown>) : undefined;
  }

  listReviews(): Record<string, unknown>[] {
    const rows = this.db.prepare(`SELECT data FROM reviews ORDER BY parked_at`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Record<string, unknown>);
  }

  deleteReview(agentId: string): void {
    this.db.prepare(`DELETE FROM reviews WHERE agent_id=?`).run(agentId);
  }
}

function rowToTask(r: Record<string, unknown>): TaskRecord {
  return {
    id: r.id as string,
    parentId: (r.parent_id as string) ?? undefined,
    title: r.title as string,
    status: r.status as TaskRecord['status'],
    tier: r.tier as TaskRecord['tier'],
    model: r.model as string,
    repo: r.repo as string,
    ownerAgent: (r.owner_agent as string) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToAgent(r: Record<string, unknown>): AgentRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    taskId: r.task_id as string,
    repo: r.repo as string,
    worktreePath: (r.worktree_path as string) ?? undefined,
    branch: (r.branch as string) ?? undefined,
    model: r.model as string,
    status: r.status as AgentRecord['status'],
    sdkSessionId: (r.sdk_session_id as string) ?? undefined,
    pid: (r.pid as number) ?? undefined,
    startedAt: r.started_at as number,
  };
}

function rowToMerge(r: Record<string, unknown>): MergeItem {
  return {
    id: r.id as number,
    branch: r.branch as string,
    taskId: r.task_id as string,
    agentId: r.agent_id as string,
    repo: r.repo as string,
    status: r.status as MergeStatus,
    gateOutput: (r.gate_output as string) ?? undefined,
    submittedAt: r.submitted_at as number,
  };
}

/**
 * Conservative glob overlap check: treats a glob as its literal prefix up to
 * the first wildcard; two globs "may overlap" if either prefix starts with
 * the other. Errs on the safe side (false positives block, never corrupt).
 */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function literalPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}
