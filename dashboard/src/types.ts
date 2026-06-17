// Single source of truth: the dashboard re-exports the hub's shared types.
// (Was a hand-maintained mirror that drifted — F1.) Keep this file a pure
// re-export so a backend shape change breaks the dashboard build, not runtime.
export type {
  Tier,
  Autonomy,
  AgentPolicy,
  TaskStatus,
  TaskRecord,
  AgentStatus,
  AgentRecord,
  CortexEvent,
  MergeStatus,
  MergeItem,
  BrainNote,
  MemoryHit,
  DiffStat,
  AgentDiff,
  ReviewDecision,
  ReviewInfo,
  CostSummary,
  StatusSnapshot,
  RepoAgent,
  RoutingDecisionRow,
} from '../../src/shared/types';
