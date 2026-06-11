# imagine-labs — Architecture

> Working tool name: **Cortex** (CLI binary: `cortex`). Project name: **imagine-labs**.
> A local-first multi-agent coding orchestrator: routes tasks to the cheapest capable model, remembers everything in an Obsidian vault, runs agents on isolated git worktrees, and shows it all in a live dashboard.

## Decisions locked in

| Decision | Choice |
|---|---|
| Agent engine | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) for workers; raw Messages API (`@anthropic-ai/sdk`) only for the routing classifier and memory summarization |
| Language/runtime | TypeScript, Node.js 22+, pnpm workspaces |
| Dashboard | React + Vite, served by the CLI via Fastify + WebSocket |
| Embeddings | Local model (fastembed / all-MiniLM class), SQLite index |
| Memory source of truth | Obsidian vault of markdown notes at `~/.cortex/brain` |
| v1 testing | Toy repos, permissive permissions inside worktrees |

### Why the Agent SDK (not raw Messages API)

The SDK gives us the agent loop, file/bash/search tools, permission hooks, subagents, session persistence/resume, context compaction, and prompt caching for free. Rebuilding those on the Messages API is months of undifferentiated work. Tradeoffs accepted: less control over the inner loop and a dependency on SDK release cadence. We mitigate provider lock-in by isolating all *direct* API calls (router classifier, memory compaction) behind a thin `ModelClient` interface; the worker-agent layer is intentionally SDK-coupled because that's where the value is.

## Component map

```
┌──────────────────────────────────────────────────────────────┐
│ cortex CLI (single Node process, the "hub")                  │
│                                                              │
│  REPL / slash commands          TUI status view              │
│  ┌─────────────┐   ┌──────────┐   ┌───────────────────────┐  │
│  │ Orchestrator│──▶│  Router  │   │ Fastify HTTP + WS     │──┼──▶ Dashboard (React, browser)
│  │ (planner)   │   │ (tiering)│   │ serves built UI bundle│  │
│  └──────┬──────┘   └──────────┘   └───────────────────────┘  │
│         │ spawns                                             │
│  ┌──────▼───────────────────────────────┐                    │
│  │ AgentManager                         │                    │
│  │  child process per agent             │                    │
│  │  (Agent SDK session in worktree)     │                    │
│  └──────┬───────────────────────────────┘                    │
│         │ reads/writes                                       │
│  ┌──────▼──────────────┐  ┌─────────────────┐                │
│  │ Coordination store  │  │ Brain            │               │
│  │ SQLite (state.db):  │  │ Obsidian vault + │               │
│  │ task board, claims, │  │ SQLite index     │               │
│  │ event log, costs    │  │ (index.db)       │               │
│  └─────────────────────┘  └─────────────────┘                │
│  ┌─────────────────────┐                                     │
│  │ GitManager           │  worktrees + merge queue           │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘
```

## Process model

- **Hub process** (`cortex` CLI): owns the REPL, orchestrator, router, coordination store, merge queue, and the dashboard server. One per machine (lockfile at `~/.cortex/hub.lock`; second invocation attaches as a client over the local WS).
- **Agent processes**: one Node child process per worker agent, each running an Agent SDK session with `cwd` set to its worktree. Crash isolation is the point — a wedged agent can be killed without touching the hub. Agents talk to the hub over a local IPC channel (newline-delimited JSON over the child's stdio); the hub mirrors everything into SQLite so state survives a hub restart.
- **Dashboard**: a browser tab connected to the hub's WebSocket. No separate server process.

## Data flow: `task "add dark mode to repo X"`

1. **Route**: heuristics (diff size hints, keywords, file count, repo familiarity) classify locally; if ambiguous, one Haiku call with a strict JSON schema returns `{tier, confidence, reason}`. Decision logged to `routing_decisions`.
2. **Plan**: orchestrator agent (top tier, but only for genuinely big tasks — small tasks skip planning) decomposes into subtasks, each with explicit file-glob ownership. Subtasks are routed *individually*.
3. **Retrieve memory**: for each subtask, query the brain index (semantic + keyword + scope + recency) for the top-k relevant notes; inject as a compact context block. Never the whole vault.
4. **Dispatch**: AgentManager creates worktree + branch `agent/<name>/<task-slug>`, spawns the agent process with its prompt, memory slice, and ownership claim. Claims are recorded as path locks in the coordination store; conflicting claims queue.
5. **Work**: agent edits/tests inside its worktree; emits events (tool use, commits, token usage, status) to the hub → SQLite → WebSocket → dashboard.
6. **Merge**: agent submits its branch to the merge queue. Queue serially rebases onto latest main, runs the gate (configurable test/lint command), merges on green. Conflict or red gate → bounced back to the owning agent with the rebase/test output.
7. **Remember**: on completion, agent writes a task-log note (and any new gotchas/decisions) to the vault; the watcher re-indexes; cost and outcome recorded.

## Storage layout

```
~/.cortex/
  config.json            # global config (tiers, budgets, concurrency, vault path)
  hub.lock
  state.db               # SQLite — coordination + ops state (regenerable-ish, but durable)
  brain/                 # Obsidian vault — SOURCE OF TRUTH for memory
    workspace/           #   conventions, preferences, cross-repo decisions
    repos/<repo>/        #   architecture notes, gotchas, task logs
    agents/<agent>/      #   per-agent learnings
    index.db             #   derived: embeddings + FTS5 (gitignored-by-convention, rebuildable)
  logs/<agent-id>.jsonl  # structured per-agent transcripts
<repo>/.cortex.json      # per-repo overrides (max model, test gate command, etc.)
worktrees live in <repo>/../.cortex-worktrees/<repo>/<branch>/
```

### state.db schema (core tables)

- `tasks(id, parent_id, title, status, tier, model, repo, owner_agent, created_at, ...)`
- `claims(agent_id, repo, path_glob, acquired_at, released_at)` — ownership locks
- `events(id, ts, agent_id, task_id, type, payload)` — append-only event log
- `routing_decisions(task_id, heuristics, classifier_output, tier, model, reason, est_cost)`
- `usage(task_id, agent_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, ts)`
- `merge_queue(id, branch, task_id, status, gate_output, position)`
- `checkpoints(agent_id, task_id, sdk_session_id, ts)` — resume after crash via SDK session resume

### Brain note format

```markdown
---
scope: repo            # workspace | repo | agent
repo: my-app
type: gotcha           # decision | convention | gotcha | task-log
created: 2026-06-10
tags: [build, vite]
pinned: false
---
Vite dev server breaks if [[node-version-convention]] isn't respected...
```

The vault is the truth; `index.db` (sqlite-vec or plain BLOB cosine + FTS5) is derived and rebuilt with `cortex memory reindex`. A chokidar watcher re-indexes on manual Obsidian edits.

## Model routing

Tiers (current pricing, per MTok in/out — fetched, not hardcoded; refreshed from the Models API at startup):

| Tier | Model | Price | Used for |
|---|---|---|---|
| cheap | `claude-haiku-4-5` | $1 / $5 | renames, formatting, small fixes, simple scripts, **the router classifier itself** |
| mid | `claude-sonnet-4-6` | $3 / $15 | standard feature work |
| top | `claude-opus-4-8` | $5 / $25 | architecture, hard debugging, large refactors, the orchestrator/planner |
| max (opt-in) | `claude-fable-5` | $10 / $50 | only via `--model` or config `max_model` |

Rules:
- Routing is heuristics-first; at most one Haiku classification call. Never an expensive model to route.
- Subtask-level re-routing: planner output tags each subtask with a suggested tier; router re-validates cheaply.
- Escalation: N consecutive gate failures / loop detection (same file edited >k times with no test progress) / stall timeout → bump one tier, log why, notify.
- Budgets: per-task and per-day caps with warn threshold + hard stop, global with per-repo overrides; `--model` / `--max-model` flags override per task.
- Every decision is a `routing_decisions` row, surfaced in the dashboard cost view.

Token-efficiency levers: prompt caching on repo maps/conventions (stable prefix, `cache_control` on the system block), memory slicing (top-k only), `effort` tuning per tier, and measured savings shown in the cost dashboard (actual vs. "everything-on-Opus" counterfactual).

## Coordination & conflict-free parallelism

- **Ownership map = path locks.** Planner assigns disjoint globs; AgentManager refuses to dispatch overlapping claims; agents requesting files outside their claim must ask the orchestrator (claim extension or handoff).
- **Event log** is the agents' shared awareness: each agent's prompt includes a digest of recent relevant events (commits by others, decisions, blockers).
- **Merge queue** is the only writer to main: serial rebase → gate → merge. Pre-merge overlap detection diffs queued branches pairwise and warns the orchestrator on region overlap even when claims were disjoint.
- **Safety**: no force-push ever; no direct commits to main; destructive git ops and anything outside a worktree require explicit approval (SDK permission hooks → hub → notification → user decision in REPL or dashboard).
- **Failure handling**: agent checkpoints = SDK session IDs persisted per task; crashed/killed agents resume the session in the same worktree. Orchestrator reaps abandoned claims after a heartbeat timeout and reassigns.

## Dashboard

- Served at `http://localhost:4242` (configurable) by the hub; real-time via WebSocket (event-log tailing — the UI is a pure projection of `events` + queries).
- **Brain view** (centerpiece): WebGL force-directed graph (pixi.js or regl + d3-force) styled after Obsidian's graph — dark bg, glow/bloom on nodes, smooth physics. Nodes: agents, repos, tasks, memory notes; edges from claims, task links, wikilinks. Status via color + motion (pulse = working, red ring = blocked, amber = awaiting review, settle = done).
- Drill-in panel per agent: live transcript stream, current diff (worktree vs base), model + token/cost meter, branch, recent memory reads/writes.
- Other views: task board (kanban), merge queue, cost dashboard (per agent/task/day vs budget + savings-from-routing), memory explorer (search/pin/delete, edits write back to the vault).
- TUI (`cortex status`): compact ink-based live table for terminal-only checks.

## Security & local-first

- API key via `ANTHROPIC_API_KEY` or macOS Keychain (`keytar`); never in config files; config loader refuses to persist anything matching a key pattern.
- Everything (code, vault, DBs, logs) stays on disk locally. No telemetry.
- All model calls go through one `ModelClient` wrapper (logging, budget enforcement, provider-swap seam).
```
