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
| Dashboard app (React, canvas force graph) | `dashboard/` |

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
