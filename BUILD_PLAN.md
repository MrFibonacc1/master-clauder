# imagine-labs — Phased Build Plan

Each phase ends with demoable acceptance criteria. Phase 1 is the one that matters — router + brain proven before any parallelism.

## Phase 0 — Skeleton (half a day)

pnpm workspace, TypeScript strict, packages: `cli`, `core` (router, brain, model client), `shared` (types). Vitest + eslint + CI script.

**Accept:** `pnpm build && pnpm test` green; `cortex --help` prints.

## Phase 1 — CLI + single agent + router + brain ⭐

**Scope**
1. **CLI/REPL**: `init` (register repo → `.cortex.json` + repo note in vault), `task "..."`, `status`, `config`, `memory` (list/search/pin/delete/reindex), REPL chat with slash commands.
2. **ModelClient**: thin wrapper over `@anthropic-ai/sdk` — usage/cost accounting per call, budget warn/hard-stop, model catalog refresh from Models API.
3. **Router**: heuristic classifier → optional single Haiku call (strict JSON output) → tier. `--model`/`--max-model` overrides. Every decision logged with reason + est. cost.
4. **Single worker agent**: Agent SDK session running in the repo (no worktree yet), streaming events to the CLI; permissive permissions (toy repos).
5. **Brain v1**: vault scaffolding (`workspace/`, `repos/`, `agents/`), note read/write with frontmatter + wikilinks, SQLite FTS5 + local embeddings (fastembed) index, chokidar watcher, top-k retrieval injected into agent prompts, task-log note written on completion.
6. **Escalation v1**: gate-failure / stall detection → bump tier, log why.

**Accept**
- `cortex init` on 2 toy repos; `cortex task "rename function X"` routes to **Haiku** (visible in `status` with reason + cost), completes.
- A gnarly task routes to Opus; cost per task visible in `cortex status`.
- Next-day fresh session: agent prompt provably includes yesterday's conventions (log the injected slice); vault opens in Obsidian with linked notes.
- Manual edit to a note in Obsidian is picked up by `cortex memory search` within seconds.
- Budget hard-stop kills a task mid-flight when the cap is hit.

## Phase 2 — Worktrees + parallelism + orchestrator + merge queue

**Scope**: GitManager (worktree/branch lifecycle, auto-cleanup), hub/agent child-process split + IPC, coordination store (task board, path-claim locks, event log), orchestrator/planner agent (decompose → subtasks with ownership → per-subtask routing), merge queue (serial rebase → test/lint gate → merge; bounce-back with context), checkpoint/resume via SDK session IDs, `pause/resume/kill <agent>` + `pause all`, 2–3 concurrent agents.

**Accept**
- One `task` spawns 3 agents on separate worktrees; `git worktree list` confirms; cleanup after merge.
- 3 agents with overlapping work in one repo merge with **zero manual conflict resolution**.
- `kill` an agent mid-task → orchestrator reassigns; resumed agent continues from checkpoint.
- No commit ever lands on main except via the queue; gate failure bounces with test output.

## Phase 3 — Dashboard

**Scope**: Fastify + WS server in hub, React/Vite app, brain-view force graph (WebGL, Obsidian-style glow/physics, status by color+motion), agent drill-in (transcript, diff, cost meter, memory reads/writes), task board, merge queue view, cost dashboard (per agent/task/day vs budget + routing savings), memory explorer with pin/delete writing back to the vault, desktop notifications (blocked/finished), `cortex dashboard` opens browser, ink TUI `cortex status --live`.

**Accept**
- Watch 3+ agents live in the graph; click-through drill-in streams the transcript with <1s latency.
- Cost view matches `usage` table to the cent; shows savings vs all-Opus counterfactual.
- Delete + pin a memory from the dashboard; file changes in the vault.

## Phase 4 — Scale & maturity

**Scope**: 5–10 concurrent agents (configurable cap, backpressure), pre-merge overlap detection, escalation polish (loop detection, auto-deescalation for easy subtasks), memory compaction (background summarize/dedupe/decay, pinned exempt), prompt caching on repo maps/conventions with measured hit rates, approval-gate hardening (destructive ops, anything touching main), exportable transcripts.

**Accept**
- 10 agents complete a fanned-out task in one repo, zero manual conflicts.
- Stale unpinned notes demonstrably decay/merge; pinned never touched.
- Cache read tokens visible and material on repeated tasks in the same repo.
- Full v1 success criteria from the original brief pass end-to-end.

## Standing rules

- Tests for router (heuristics table-driven), brain retrieval, merge queue state machine — these are the correctness cores.
- No hardcoded model IDs/prices outside the catalog module.
- Every phase keeps `cortex` usable on macOS + Linux.
