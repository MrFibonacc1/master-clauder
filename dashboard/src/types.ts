// Minimal mirror of the hub's shared types (dashboard is a separate package).

export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'blocked'
  | 'awaiting-merge'
  | 'needs-review'
  | 'done'
  | 'failed'
  | 'killed';

export interface TaskRecord {
  id: string;
  parentId?: string;
  title: string;
  status: TaskStatus;
  tier: string;
  model: string;
  repo: string;
  ownerAgent?: string;
  createdAt: number;
  updatedAt: number;
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
  startedAt: number;
  sdkSessionId?: string;
}

export interface RepoAgent {
  id: string;
  name: string;
  status: AgentStatus;
  model: string;
  branch?: string;
  worktreePath?: string;
  sdkSessionId?: string;
  taskId: string;
  taskTitle: string;
  cost: number;
}

export interface CortexEvent {
  id: number;
  ts: number;
  type: string;
  agentId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface MergeItem {
  id: number;
  branch: string;
  taskId: string;
  agentId: string;
  repo: string;
  status: 'queued' | 'rebasing' | 'testing' | 'merged' | 'conflict' | 'gate-failed';
  gateOutput?: string;
  submittedAt: number;
}

export interface CostSummary {
  byTask: Record<string, number>;
  byAgent: Record<string, number>;
  total: number;
}

export interface BrainNote {
  relPath: string;
  title: string;
  scope: string;
  repo?: string;
  type: string;
  tags: string[];
  pinned: boolean;
  created: string;
  body: string;
  links: string[];
}

export interface MemoryHit {
  note: BrainNote;
  score: number;
}

export interface StatusSnapshot {
  tasks: TaskRecord[];
  agents: AgentRecord[];
  costs: CostSummary;
  daySpendUsd: number;
  budget: { perTaskUsd: number; perDayUsd: number; warnRatio: number };
  mergeQueue: MergeItem[];
}

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

export interface RoutingDecisionRow {
  taskId: string;
  tier: string;
  model: string;
  reason: string;
  source: string;
  ts: number;
}
