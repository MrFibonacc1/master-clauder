# imagine-labs — Cortex

Local-first multi-agent coding orchestrator CLI. Routes each task to the cheapest capable Claude model, remembers everything in an Obsidian vault, runs agents in parallel on isolated git worktrees, and shows it all in a live dashboard.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [BUILD_PLAN.md](BUILD_PLAN.md) for the phase plan.

## Setup

```sh
pnpm install
pnpm build            # compiles server (tsc) + dashboard (vite)
export ANTHROPIC_API_KEY=sk-ant-...   # never goes in config files
```

## Quick start

```sh
node dist/cli/index.js init ~/code/my-repo     # register a repo
node dist/cli/index.js task "rename getUser to fetchUser" -r my-repo
node dist/cli/index.js status                  # tasks, agents, cost vs budget
node dist/cli/index.js dashboard               # live graph at localhost:4242
node dist/cli/index.js                         # REPL (chat + /slash commands)
```

Or during development: `pnpm dev <command>` (tsx, no build needed).

## What's inside

| Area | Files |
|---|---|
| Shared contracts | `src/shared/types.ts` |
| Coordination store (SQLite: tasks, claims, events, usage, merge queue) | `src/core/store.ts` |
| Model catalog + cost math + budget-enforcing client | `src/core/models.ts`, `src/core/modelClient.ts` |
| Cost-aware router (heuristics → one Haiku call → clamp; escalation) | `src/core/router.ts` |
| Brain (Obsidian vault + FTS5 index + watcher + retrieval) | `src/core/brain.ts` |
| Git worktrees / branches / ff-only merges | `src/orchestration/git.ts` |
| Agent child process (Claude Agent SDK session) | `src/orchestration/agentRunner.ts` |
| Agent lifecycle, IPC, checkpoints, pause/kill | `src/orchestration/agentManager.ts` |
| Merge queue (rebase → gate → merge, bounce-back) | `src/orchestration/mergeQueue.ts` |
| Planner (decompose → owned subtasks) | `src/orchestration/orchestrator.ts` |
| Composition root + dispatch flow | `src/cli/hub.ts` |
| CLI + REPL | `src/cli/index.ts` |
| Dashboard server (Fastify + WS) | `src/cli/server.ts` |
| Dashboard app (React, canvas) — brain graph + farm view | `dashboard/` |

## Dashboard

`cortex dashboard` (or any session — it auto-starts) serves a live web UI at `http://localhost:4242`:

- **Launch & manage from the browser** — the **+ New task** button opens a composer (task, repo, model). Model defaults to **Auto (router picks the cheapest capable tier)**; override per task or cap the max tier. **Pause all** halts every agent.
- **Two switchable agent visualizations** (tabs, last choice remembered):
  - **Brain** — Obsidian-style glowing force graph: agents, repos, tasks, memory notes.
  - **Farm** — an isometric farm where each agent is a worker in its repo's plot. Status reads from what they're *doing*: working = swinging a hoe + growing crops, blocked = frozen with a red "!", paused = sitting with "Zzz", done = green ✓ + a golden sheaf, failed = slumped with smoke. Click a worker for its live transcript, model, cost, and branch.
- **Click a repo** (a node in the graph, or a barn in the farm) to open its **session drawer** — every agent that has worked on that repo, with status, model, branch, and cost. Each session has **Open in Claude Code** (runs `claude --resume <sessionId>` in that agent's worktree, so you drop straight back into it), **Reveal** (opens the worktree folder), and a copyable resume command.
- Also: task board, merge queue, cost dashboard (per agent/task/day vs budget), memory explorer (pin/delete writes back to the vault).

## Review before merge

Turn this on and a finished agent **parks for human review** instead of auto-merging: it holds its worktree, and you see the diff in the dashboard's **Review** tab. **Approve & merge** sends the branch through the merge queue; **Request changes** (with a comment) resumes the same agent — its session intact — to address the feedback. Reviews are persisted in the store, so they survive across CLI/dashboard processes.

Enable per task (`cortex task "..." --review` or the composer's "Review before merge" checkbox), per repo (`reviewBeforeMerge` in `.cortex.json`), or globally (`cortex config set reviewBeforeMerge true`). Backed by `GET /api/reviews`, `GET /api/agents/:id/diff`, `POST /api/agents/:id/review`; lifecycle in [src/cli/hub.ts](src/cli/hub.ts).

## Autonomy (permissions)

Agents run without pestering you for permission on routine work, while the genuinely dangerous actions are gated. Set globally (`cortex config set autonomy <level>`), per repo (`.cortex.json`), per task (`--yolo` / `--careful`), or in the dashboard composer.

| Level | Behavior |
|---|---|
| `standard` (default) | Auto-grants the safe ~95% — reads anywhere, edits/commits inside the worktree, tests, builds, ordinary git. Gates the dangerous few (`git push`, `--force`/`--hard`, `rm -rf`, `reset --hard`, publish, `sudo`, writes outside the worktree) with an actionable message the agent adapts to. |
| `full` (`--yolo`) | Never asks; allows everything. |
| `careful` | Read-and-plan: reads and read-only commands allowed; edits and mutating commands gated. |

The policy lives in [`src/core/permissions.ts`](src/core/permissions.ts) and is enforced via the Agent SDK's `canUseTool` hook; gated calls surface as `blocked:<tool>` events in the transcript and dashboard.

## Model tiers

| Tier | Model | $/MTok in/out |
|---|---|---|
| cheap | claude-haiku-4-5 | 1 / 5 |
| mid | claude-sonnet-4-6 | 3 / 15 |
| top | claude-opus-4-8 | 5 / 25 |
| max (opt-in) | claude-fable-5 | 10 / 50 |

Override per task with `--model <id>` / `--max-model <tier>`. Budgets (per task / per day, warn + hard stop) in `config.json` — `cortex config set budget.perDayUsd 50`.

## Memory

The brain is a plain Obsidian vault at `~/.cortex/brain` (markdown + YAML frontmatter + `[[wikilinks]]`). Open it in Obsidian; manual edits are re-indexed automatically. CLI: `cortex memory search|list|pin|unpin|delete|reindex`. Dashboard has a memory explorer too.

## Tests

```sh
pnpm test   # 62 tests: router heuristics, brain, git/worktrees, merge queue, planner, server
```

## Safety

- Agents only ever write inside their own worktree; main is touched only by the merge queue (ff-only, never force).
- API keys live in env vars only — the config writer refuses to persist anything key-shaped.
- Everything (code, vault, DBs, logs) stays on your machine.
