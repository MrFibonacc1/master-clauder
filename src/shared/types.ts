/**
 * Shared type contracts for imagine-labs (Cortex).
 * Every module builds against these — change with care.
 */

// ---------- Model routing ----------

export type Tier = 'cheap' | 'mid' | 'top' | 'max';

/** How much an agent is allowed to do without a permission gate.
 *  full = never ask (bypass), standard = auto-grant the safe ~95% & gate the
 *  dangerous few, careful = read-and-plan (mutations gated). */
export type Autonomy = 'full' | 'standard' | 'careful';

export interface ModelInfo {
  tier: Tier;
  id: string; // e.g. "claude-haiku-4-5"
  inputPerMTok: number; // USD
  outputPerMTok: number; // USD
}

export interface RoutingDecision {
  taskId: string;
  tier: Tier;
  model: string;
  reason: string;
  source: 'heuristic' | 'classifier' | 'override' | 'escalation';
  estCostUsd?: number;
  ts: number;
}

export interface Usage {
  taskId: string;
  agentId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  ts: number;
}

export interface BudgetConfig {
  perTaskUsd: number;
  perDayUsd: number;
  warnRatio: number; // e.g. 0.8 -> warn at 80%
}

// ---------- Config ----------

export interface CortexConfig {
  vaultPath: string; // default ~/.cortex/brain
  maxModel: Tier; // highest tier allowed
  defaultTier: Tier;
  autonomy: Autonomy; // default permission autonomy for agents
  reviewBeforeMerge: boolean; // if true, finished agents park for human diff review before merging
  concurrency: number; // max concurrent agents
  dashboardPort: number;
  budget: BudgetConfig;
  repos: Record<string, RepoConfig>; // keyed by repo name
}

export interface RepoConfig {
  name: string;
  path: string;
  maxModel?: Tier;
  autonomy?: Autonomy; // per-repo override of the global autonomy
  reviewBeforeMerge?: boolean; // per-repo override of review-before-merge
  gateCommand?: string; // test/lint gate for merge queue, e.g. "npm test"
  mainBranch?: string; // default "main"
}

// ---------- Diff review (A1) ----------

export interface DiffStat {
  file: string;
  additions: number;
  deletions: number;
}

export interface AgentDiff {
  agentId: string;
  branch?: string;
  files: DiffStat[];
  patch: string;
}

export type ReviewDecision = 'approve' | 'request-changes';

/** A finished agent parked awaiting human review (reviewBeforeMerge). */
export interface ReviewInfo {
  agentId: string;
  agentName: string;
  taskId: string;
  taskTitle: string;
  repo: string;
  branch: string;
  model: string;
  summary: string;
  parkedAt: number;
}

// ---------- Tasks & coordination ----------

export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'blocked'
  | 'needs-review'
  | 'awaiting-merge'
  | 'done'
  | 'failed'
  | 'killed';

export interface TaskRecord {
  id: string;
  parentId?: string;
  title: string;
  status: TaskStatus;
  tier: Tier;
  model: string;
  repo: string;
  ownerAgent?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Claim {
  agentId: string;
  repo: string;
  pathGlob: string;
  acquiredAt: number;
  releasedAt?: number;
}

export type AgentStatus =
  | 'starting'
  | 'working'
  | 'blocked'
  | 'paused'
  | 'needs-review'
  | 'done'
  | 'failed'
  | 'killed';

export interface AgentRecord {
  id: string;
  name: string;
  taskId: string;
  repo: string;
  worktreePath?: string;
  branch?: string;
  model: string;
  status: AgentStatus;
  sdkSessionId?: string; // checkpoint for resume
  pid?: number;
  startedAt: number;
}

// ---------- Events (the shared awareness log) ----------

export type EventType =
  | 'task.created'
  | 'task.routed'
  | 'task.status'
  | 'agent.spawned'
  | 'agent.status'
  | 'agent.message' // streamed assistant text
  | 'agent.tool' // tool use summary
  | 'agent.usage'
  | 'agent.memory' // memory read/write
  | 'claim.acquired'
  | 'claim.released'
  | 'merge.submitted'
  | 'merge.result'
  | 'budget.warn'
  | 'budget.stop'
  | 'approval.requested'
  | 'approval.resolved';

export interface CortexEvent {
  id: number; // autoincrement from store
  ts: number;
  type: EventType;
  agentId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export type NewEvent = Omit<CortexEvent, 'id'>;

// ---------- Merge queue ----------

export type MergeStatus = 'queued' | 'rebasing' | 'testing' | 'merged' | 'conflict' | 'gate-failed';

export interface MergeItem {
  id: number;
  branch: string;
  taskId: string;
  agentId: string;
  repo: string;
  status: MergeStatus;
  gateOutput?: string;
  submittedAt: number;
}

// ---------- Brain (memory) ----------

export type NoteScope = 'workspace' | 'repo' | 'agent';
export type NoteType = 'decision' | 'convention' | 'gotcha' | 'task-log';

export interface BrainNote {
  /** path relative to vault root, e.g. "repos/my-app/gotcha-vite-node.md" */
  relPath: string;
  title: string;
  scope: NoteScope;
  repo?: string;
  agent?: string;
  type: NoteType;
  tags: string[];
  pinned: boolean;
  created: string; // ISO date
  body: string;
  links: string[]; // wikilink targets
}

export interface MemoryHit {
  note: BrainNote;
  score: number;
}

// ---------- Planner ----------

export interface PlannedSubtask {
  title: string;
  prompt: string;
  ownership: string[]; // path globs this subtask owns
  suggestedTier: Tier;
}

export interface Plan {
  subtasks: PlannedSubtask[];
  notes?: string;
}

// ---------- IPC between hub and agent child process ----------

export type AgentToHubMsg =
  | { kind: 'status'; status: AgentStatus; detail?: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; usage: Omit<Usage, 'taskId' | 'agentId' | 'ts'> }
  | { kind: 'memory'; op: 'read' | 'write'; relPath: string }
  | { kind: 'session'; sdkSessionId: string }
  | { kind: 'approval'; id: string; action: string }
  | { kind: 'done'; success: boolean; summary: string };

export type HubToAgentMsg =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'kill' }
  | { kind: 'approval'; id: string; allow: boolean }
  | { kind: 'context'; text: string }; // injected event-log digest
