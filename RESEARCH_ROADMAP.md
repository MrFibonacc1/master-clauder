# Cortex Integration Roadmap — Become the Best Open-Source "Code Faster" Tool

Synthesized from four reference projects (**vibe-kanban**, **opcode**, **ccstatusline**, **claude-squad**), deduped against what Cortex already ships, and ranked by **value-for-speed ÷ effort**.

## What I dropped (Cortex already has it — don't rebuild)

These appeared as "gaps" in one repo's lens but are genuinely covered:

- **Worktree-per-agent isolation, concurrency, pause/resume/kill, persistence** — `git.ts`, `agentManager.ts`, `store.ts`. (all four repos)
- **Cost/usage tracking + budgets** richer than ccstatusline/opcode — `store.ts` usage table, `CostsView.tsx`. *(But the dollar figures are synthetic on a subscription — see Theme C.)*
- **Review-gated promotion via serial merge queue** (rebase → gate → ff-only, never force) — stronger than claude-squad's keypress-push. `mergeQueue.ts`.
- **Resume/escalation via SDK session id**, "Open in Claude Code" deep-link — `hub.ts` `spawnOnce`, `server.ts` `buildResumeCommand`.
- **Token usage read natively from the SDK `result` message** — do NOT adopt ccstatusline's JSONL transcript re-parser; `agentRunner.ts` already pulls `message.usage` + `total_cost_usd`.
- **WS live event stream, task board, brain graph, farm view, cost dashboard** — `server.ts` `/ws`, `dashboard/src/views/*`.

One correctness note found while verifying: `git.ts:55` hardcodes `'main'` as the worktree base even though `RepoConfig.mainBranch` exists. Worth fixing alongside any merge/review work below.

---

## The single biggest convergent gap

**Three of four repos (vibe-kanban, opcode, claude-squad) center on the same missing loop: a human DIFF REVIEW surface in the dashboard.** Cortex computes `GitManager.diffAgainstMain()`/`changedFiles()` but **never exposes them over the API or renders them anywhere** (verified: no diff route in `server.ts`, no diff view in `dashboard/`). Today `runSubtask` auto-submits to the merge queue on success (`hub.ts:252`) and the queue auto-merges — a human never sees the change before it lands. This is the highest-leverage single addition and the backbone of Theme A.

---

## Theme A — Review & Merge (the describe → review → ship loop)

### A1. Diff review pane + approve-to-merge gate ⭐ TOP PICK
- **What:** Dashboard view rendering an agent's worktree diff with +/- line stats; **Approve & enqueue merge** / **Request changes** actions. Add a config flag `reviewBeforeMerge` and a new `needs-review` status so a successful agent parks instead of auto-submitting.
- **Inspired by:** vibe-kanban, opcode, claude-squad (all three).
- **Why faster:** Fan out many agents, triage their diffs in one place, promote only the good ones — far faster than reading raw logs or `auto-merge-or-bust`. Catches bad changes before they hit main.
- **Effort:** **M**
- **Integrate:** `GET /api/agents/:id/diff` + `/changed-files` in `server.ts` → `hub.git.diffAgainstMain(worktreePath, mainBranch)`. Add `needs-review` to `TaskStatus`/`AgentStatus` in `shared/types.ts`; in `hub.ts` `runSubtask`, when `reviewBeforeMerge` set, emit `needs-review` instead of `store.submitMerge`. Add `POST /api/agents/:id/review {decision, comments}` → on approve call `store.submitMerge`; on changes resume the agent via the existing `spawnOnce(resumeSessionId)` path with comments appended. New `dashboard/src/views/ReviewView.tsx` (use `react-diff-view`) + card action in `TaskBoard.tsx`. `mergeQueue.ts` unchanged. Add flag to `config.ts`.

### A2. GitHub PR creation with AI-generated description
- **What:** Optional `mergeMode: 'local' | 'github-pr'`. On gate pass, `git push -u origin <branch>` then `gh pr create` with a Haiku-generated title/body over the diff.
- **Inspired by:** vibe-kanban. *(ccstatusline's PR-review-state awareness is the read-side cousin — fold it in later as an optional `requireApproval` gate.)*
- **Why faster:** Lets Cortex output flow through a team's real GitHub review/CI process instead of local-only merges — what makes the tool usable on shared repos. AI write-ups save the human step.
- **Effort:** **M**
- **Integrate:** Add `mergeMode` + `requireApproval?` to `RepoConfig` in `shared/types.ts`. In `mergeQueue.ts`, branch on `mergeMode`; generate title/body via `modelClient.complete()` routed to cheap tier over `git.diffAgainstMain`. Uses the user's already-authenticated `gh` CLI (consistent with subscription-auth philosophy — no new credentials). Add `pr-open` `MergeStatus`, store PR URL on `MergeItem`, link in `MergeQueueView.tsx`. Gate behind `gh` presence; fall back to local. Keep the no-force-push guarantee.

---

## Theme B — Orchestration UX (steer & recover from running agents)

### B1. Session checkpoint + restore (working-tree snapshots) ⭐ FLAGSHIP BET
- **What:** Checkpoint an agent at any point capturing (a) SDK session id *(already tracked)* PLUS (b) a git snapshot of the worktree (`git stash create` → hidden ref). One-click **Restore** does `git reset --hard <ref>` and resumes the session. Note: there is **no `checkpoints` table today** — the store header comment claims one but it doesn't exist; "checkpoints" are just session ids on the agents row.
- **Inspired by:** opcode (flagship feature).
- **Why faster:** Removes the fear that makes people babysit agents — let an agent try an aggressive change and instant-rollback if it goes sideways. Non-linear, reversible sessions.
- **Effort:** **M**
- **Integrate:** Add real `checkpoints` table to `store.ts` (id, agent_id, task_id, sdk_session_id, git_ref, label, ts). Add `createCheckpoint`/`restoreCheckpoint` to `git.ts`. **Requires a controlled exception in `permissions.ts`**: `git reset --hard` is currently gated (`RISKY_BASH` line 36) — the restore path must bypass `evaluateTool` since it's hub-initiated, not agent-initiated. Auto-checkpoint from `agentManager.ts` on `done`/tool milestones. `POST /api/agents/:id/checkpoint` + `/restore` in `server.ts`; list + Restore button in `AgentDrawer.tsx`.

### B2. Live attach/detach into a running agent (interactive takeover)
- **What:** Stream an agent's full NDJSON transcript to the dashboard and add a `HubToAgentMsg {kind:'inject', text}` that feeds operator text as the next user turn. Read it, nudge it, detach.
- **Inspired by:** claude-squad (its ergonomic heart). Overlaps vibe-kanban's per-task terminal.
- **Why faster:** Turns a blocked/slightly-off agent into a 2-second nudge instead of kill-and-restart — the most common reason multi-agent runs waste a full re-route.
- **Effort:** **L** (requires switching the SDK `prompt` to an async iterable).
- **Integrate:** Extend `HubToAgentMsg` in `shared/types.ts` with `inject`; in `agentRunner.ts` switch `prompt` to an async iterable so injected turns append. Add `AgentManager.inject()` reusing `sendToAgent`. `POST /api/agents/:id/inject` + WS transcript channel (tail the existing `<agentId>.jsonl`) in `server.ts`. Attach panel in `AgentDrawer.tsx`. **Ship B5 first as the read-only half.**

### B3. Human-in-the-loop approval gate wired end-to-end
- **What:** In `careful` autonomy, a gated dangerous call surfaces an Approve/Deny prompt in the dashboard and the agent **blocks** until the human responds (instead of today's auto-deny-with-message). Most plumbing already exists.
- **Inspired by:** vibe-kanban + claude-squad (Cortex's own notes call this "minimal").
- **Why faster:** Run agents at higher autonomy on risky tasks without babysitting the terminal — approve the occasional dangerous step from the browser.
- **Effort:** **S**
- **Integrate:** No new event types needed — `approval.requested`/`approval.resolved` and `HubToAgentMsg {kind:'approval'}` already exist in `shared/types.ts`. In `agentRunner.ts` `canUseTool`, for a `deny` in careful mode emit `{kind:'approval', id, action}` and await a resume signal; resolve on `{kind:'approval', id, allow}` via the stdin handler. Forward through `AgentManager.sendToAgent` (`agentManager.ts`). `POST /api/approvals/:id` in `server.ts` + approval toast in the dashboard driven off `approval.requested` already streaming over `/ws`.

### B5. Single-agent live log tail endpoint ⚡ QUICK WIN
- **What:** Endpoint + UI tab to stream one agent's full transcript (the `<agentId>.jsonl` `AgentManager` already writes), instead of the compact truncated store events.
- **Inspired by:** claude-squad. Read-only half of B2 — ship first.
- **Why faster:** Debug a misbehaving agent in one click instead of opening jsonl on disk — prerequisite for trusting unattended fan-out.
- **Effort:** **S**
- **Integrate:** `GET /api/agents/:id/log` tailing `path.join(CORTEX_HOME, 'logs', '<id>.jsonl')` + a WS topic pushing new lines, in `server.ts`. `AgentManager` already `createWriteStream`s the file — no backend changes there. Render in a "Log" tab of `AgentDrawer.tsx`.

### B6. Idle / needs-input / stuck detection ⚡ QUICK WIN
- **What:** Classify each running agent as working vs idle-stalled vs likely-needs-input from the timestamp of the last `AgentToHubMsg` (no message for N seconds → idle), and surface the existing `blocked:<tool>` deny events as a distinct flag.
- **Inspired by:** claude-squad (it SHA-hashes a PTY every 500ms; Cortex gets a cleaner version free from its structured event stream).
- **Why faster:** Tells the operator at a glance which of N agents need attention instead of scanning all of them — directly speeds farm/board triage.
- **Effort:** **S**
- **Integrate:** Track `lastMsgTs` per `RunningAgent` in `agentManager.ts` `handleMsg`; a small `setInterval` flips `record.status` to a new `idle` state after a configurable stall window, emitting `agent.status`. `agentRunner.ts` already emits `blocked:<tool>` (line 87). Render as badge/animation in `FarmView.tsx` + `TaskBoard.tsx`.

---

## Theme C — Observability & Status (real go/no-go on a subscription)

### C1. Subscription rate-limit (quota) tracking & budgeting ⭐ HIGH-VALUE
- **What:** Read the Claude Code OAuth token (macOS Keychain service `Claude Code-credentials`, or `~/.claude/.credentials.json`) and `GET https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`. Parse `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus` utilization + `resets_at` + extra-usage credits. Cache to `~/.cortex/cache/usage.json` (~180s TTL + lock so concurrent agents make one call).
- **Inspired by:** ccstatusline.
- **Why faster:** Cortex's headline is "runs on your subscription, no API key" — but the real constraint is the **5-hour and weekly caps**, not dollars. The entire budget system (`models.ts costUsd` + `store.usage`) tracks synthetic API-list-price USD that is **meaningless on a subscription**. Surfacing "session 78%, resets in 41m; weekly-Opus 91%" lets the router proactively down-tier or pause-all *before* Claude Code starts rejecting requests — the failure that actually halts a long parallel run. Turns a fake-dollar gauge into a real go/no-go signal.
- **Effort:** **M**
- **Integrate:** New `src/core/usage.ts` (token read + fetch + cache, deps-injected). `SubscriptionUsage` type in `shared/types.ts`. Wire into `router.ts` (refuse escalation to Opus when `weeklyOpus > 90%` — note routing already clamps via `clampTier`/`escalate`, so this is a natural extra guard) and into `modelClient.ts` budget enforcement (add "quota warn"/"quota stop" alongside the USD ones). `GET /api/usage` in `server.ts` + panel in `CostsView.tsx`; figures in `renderStatus()` in `cli/index.ts`.

### C2. Disk-backed TTL+mtime cache for git/gh calls ⚡ QUICK WIN
- **What:** Generic content-addressed cache (sha256 of cwd+branch+command → `~/.cortex/cache/<hash>.json`, mtime TTL, empty-file = negative cache) over the repeated `git`/`gh` calls Cortex makes when many agents share a repo.
- **Inspired by:** ccstatusline (`git-review-cache.ts`).
- **Why faster:** Every status refresh, dashboard poll, and prompt build re-shells `git` for branch/remote state on the same repo. Short-TTL caching removes redundant subprocess spawns, keeping the dashboard and status loop snappy under parallel load.
- **Effort:** **S**
- **Integrate:** New `src/orchestration/gitCache.ts` wrapping the read-only helpers in `git.ts` (branch/status/remote) + any `gh` lookup. Keep the deps-injection shape for unit-testability.

### C3. Compact one-line live status (width-aware/flex render)
- **What:** A dense single-line hub summary (`cortex · 3 agents ●2 working ●1 blocked · mergeq:1 · day $4.10/25 · sess 78%`) with terminal-width detection + per-segment truncation; pipeable into tmux/shell prompt.
- **Inspired by:** ccstatusline (`renderer.ts`).
- **Why faster:** Monitor a parallel run from the corner of a terminal instead of context-switching to the dashboard. Today `cortex status` is a full-screen multi-line dump with hard `slice()` truncation.
- **Effort:** **M**
- **Integrate:** `renderStatusLine(hub): string` next to `renderStatus()` in `cli/index.ts` + a width/flex helper in new `src/cli/statusline.ts` (lift logic from ccstatusline `renderer.ts`/`terminal.ts`). Add `cortex status --line`. Best paired with C1 so the `sess 78%` segment is real. No new deps.

### C4. Self-install / doctor command
- **What:** `cortex install` / `cortex doctor`: detect Claude Code version via `claude --version`, locate config dir (respecting `CLAUDE_CONFIG_DIR`), verify the `claude` CLI/SDK is present and authed, register Cortex's global bin. Not for writing a statusLine — for verifying the host Cortex rides on.
- **Inspired by:** ccstatusline (`claude-settings.ts`).
- **Why faster:** Cortex's whole worker layer depends on a working, logged-in Claude Code at a compatible version. A one-shot doctor removes the most common "why won't agents start" setup failure.
- **Effort:** **S**
- **Integrate:** New `src/cli/install.ts` registered in `cli/index.ts`; lift `getClaudeConfigDir`/`getClaudeCodeVersion`/`isClaudeCodeVersionAtLeast` from ccstatusline.

---

## Theme D — Agent Backends (de-risk single-vendor lock-in)

### D1. Pluggable executor interface (agent-agnostic workers)
- **What:** Extract a `CodingAgentExecutor` interface (run → emits existing `AgentToHubMsg` stream); current `agentRunner.ts` becomes the default `ClaudeExecutor`. Add runners for pre-authenticated CLIs (Codex, Gemini, Aider, Amp, OpenCode…), selectable per-task. Configure via a `profiles` map + `defaultProgram` (claude-squad's shape).
- **Inspired by:** vibe-kanban (10+ agents) + claude-squad (profiles) + opcode. Strongly convergent across three repos.
- **Why faster:** Lets teams keep Cortex's superior orchestration (worktrees + merge queue + **cost routing** + brain) while dispatching each subtask to whichever agent is best/cheapest. Purely additive to Cortex's routing/budget layer and widens adoption.
- **Effort:** **L**
- **Integrate:** `interface CodingAgentExecutor` in new `src/orchestration/executors/types.ts`; move `agentRunner.ts` logic into `executors/claude.ts`. Add e.g. `executors/codex.ts` spawning the CLI in `cfg.worktreePath` and mapping stdout to `AgentToHubMsg`. `AgentManager.doSpawn` selects by an `executor`/`profile` field added to `AgentSpawnSpec`/`AgentRecord`/`DispatchOpts`. **Critical:** `router.ts` is hardwired to `MODEL_CATALOG` Claude tiers (verified) and SDK session resume/escalation only apply to Claude — **gate those code paths on `profile === 'claude'`**; non-Claude executors bypass tier routing and report cost (or zero if unknown) via the result stream.

---

## Theme E — Reuse & Capability (codify and extend agents)

### E1. Saved, reusable agent presets
- **What:** First-class preset = `{ name, systemPrompt, defaultTier, autonomy, optional path-ownership defaults }`, selectable at dispatch (CLI flag + composer dropdown), re-runnable, with run-history rollups (success rate, avg cost/time).
- **Inspired by:** opcode ("CC Agents", its #2 feature).
- **Why faster:** Codify "my test-writer agent", "my refactor agent" once instead of re-typing prompts and re-picking models each task. The system prompt is currently **hard-coded** at `agentRunner.ts:68` and agents are auto-named ephemeral `agent-xxxxxx` — presets are a direct throughput multiplier.
- **Effort:** **M**
- **Integrate:** `agent_presets` table (or JSON under `CORTEX_HOME`) with CRUD in `store.ts`. Thread `systemPromptOverride`/`presetId` through `DispatchOpts` (`hub.ts`) → `AgentSpawnSpec` (`agentManager.ts`) → `AgentRunnerConfig` (`agentRunner.ts`). `cortex agent preset create|list` in `cli/index.ts` + selector in the composer in `App.tsx`. Compute history from existing usage/events tables. Storing presets as brain-vault markdown gets sharing/versioning free.

### E2. Per-agent / per-preset permission scoping (paths + network) ⚡ QUICK WIN
- **What:** Extend the single global autonomy LEVEL to per-agent allow/deny: which path globs the agent may write, whether network/WebFetch is allowed — driven by preset and/or the planner's ownership claims.
- **Inspired by:** opcode (per-agent blast radius in the UI).
- **Why faster:** Tighter scoping = safely run more agents on standard/full without babysitting; fewer permission stalls. Also makes the existing ownership claims **enforceable at the tool layer**, not just advisory.
- **Effort:** **S**
- **Integrate:** `evaluateTool()` in `permissions.ts` already takes `(autonomy, toolName, input, worktree)` and already resolves write-tool paths via `toolPath`/`isInsideWorktree` — extend the signature with a per-agent policy `{ writeGlobs, allowNetwork }`, check write targets against `writeGlobs`, deny `WebFetch`/network when `allowNetwork` is false. Pass the policy through `AgentRunnerConfig` from the preset/ownership in `hub.ts`. The `canUseTool` wiring at `agentRunner.ts:84` stays unchanged.

### E3. CLAUDE.md awareness: discovery, editor, prompt injection ⚡ QUICK WIN
- **What:** Discover `CLAUDE.md` in each registered repo, let users view/edit it in the dashboard, and inject it into agent prompts alongside the brain memory context.
- **Inspired by:** opcode (built-in CLAUDE.md editor). Cortex has **zero** CLAUDE.md awareness today (verified).
- **Why faster:** Agents follow the repo's real conventions (the CLAUDE.md the team already maintains) → fewer wrong-style outputs and rejected merges, so changes land right the first time.
- **Effort:** **S**
- **Integrate:** In `hub.ts` `runSubtask`, read `<repoPath>/CLAUDE.md` (+ nested) and prepend next to `memoryContext` (prompt assembled at `agentRunner.ts:68` / `hub.ts:213`). `GET/PUT /api/repos/:name/claude-md` in `server.ts` + editor view. Reuse the gray-matter/markdown handling already in `brain.ts`.

### E4. MCP server registry
- **What:** Small UI/CLI to register MCP servers, test connectivity, import from the user's existing Claude config, and attach selected servers to presets so workers launch with them enabled.
- **Inspired by:** opcode (MCP registry).
- **Why faster:** Agents gain tools (DBs, browsers, internal APIs) without hand-editing JSON per project — tool-dependent tasks succeed on the first try.
- **Effort:** **M**
- **Integrate:** Store MCP configs under `CORTEX_HOME` (or per-preset); **import the user's existing `~/.claude` config rather than reimplementing the protocol**. Pass selected servers into the Agent SDK `query()` options in `agentRunner.ts` via `AgentRunnerConfig`. CRUD + test-connection endpoint in `server.ts`, MCP tab in `App.tsx`. Reuse existing mcp-registry/connector tooling over a bespoke registry.

---

## Theme F — Developer Velocity (internal correctness)

### F1. Auto-generated TS types (ts-rs equivalent) ⚡ QUICK WIN
- **What:** Make `src/shared/types.ts` the single source of truth and **delete the hand-maintained `dashboard/src/types.ts`** (its own header literally says "Minimal mirror of the hub's shared types" — verified drift risk).
- **Inspired by:** vibe-kanban (ts-rs).
- **Why faster:** A backend shape change that breaks the frontend currently fails at runtime; this makes it fail at build time — a real velocity win on a fast-moving orchestrator.
- **Effort:** **S**
- **Integrate:** Add a path alias in `dashboard/tsconfig` + `dashboard/vite.config.ts` resolving `@shared/types` → `src/shared/types.ts`; re-export API shapes from there; delete the duplicate. Lift the request/response envelope shapes currently inlined in `server.ts` handlers into `shared/types.ts`. Add a typecheck step to the dashboard build so drift breaks CI.

---

## Theme G — Preview (see-it-then-ship-it)

### G1. Per-workspace dev server + embedded preview
- **What:** Optionally start a dev server in each worktree on an auto-assigned port (`devServerCommand` per repo), track it with the agent, embed an iframe preview in the dashboard.
- **Inspired by:** vibe-kanban (isolated dev server + preview; embedded DevTools is out of scope).
- **Why faster:** Makes "does the change actually work in the app?" a one-glance part of review instead of manual checkout-and-run. Combined with A1's diff pane = true see-it-then-ship-it.
- **Effort:** **L**
- **Integrate:** `devServerCommand` in `RepoConfig` (`shared/types.ts`). New `DevServerManager` in `src/orchestration/` that allocates a free port and spawns with `cwd=worktreePath` (reuse `agentManager.ts` child-process patterns); store URL on `AgentRecord`. `POST /api/agents/:id/dev-server/{start,stop}` + status in `server.ts`. New `PreviewView.tsx` with an `<iframe>`. Teardown must hook into agent kill + worktree removal.

---

## ⭐ Do This Next — top 7 by leverage

Ordered for compounding value; the first four are the spine of the "code faster" story.

1. **A1 — Diff review pane + approve-to-merge gate (M).** The convergent #1 gap (vibe-kanban + opcode + claude-squad). Unlocks the whole describe→review→ship loop; the git plumbing already exists.
2. **C1 — Subscription quota tracking (M).** Fixes the most dangerous blind spot: Cortex budgets in fake dollars while the real cap (5-hour / weekly) silently halts long runs. Turns the budget system into a real go/no-go signal.
3. **B1 — Session checkpoint + restore (M).** opcode's flagship; removes the fear that makes people babysit agents. Highest "wow" per unit effort once the store table exists.
4. **E2 — Per-agent permission scoping (S).** Quick win that makes existing ownership claims enforceable and lets you safely fan out more agents on higher autonomy — `evaluateTool` already does 90% of the work.
5. **B5 + B6 — Live log tail + idle/stuck detection (S + S).** Cheap observability pair; B5 is also the read-only half of full attach (B2). Makes unattended fan-out trustworthy.
6. **E3 — CLAUDE.md awareness (S).** Cheapest way to cut rejected-merge rate: agents follow the repo's real conventions on the first try. Zero today.
7. **F1 — Shared types / kill the dashboard mirror (S).** Foundational hygiene that prevents a class of silent breakages while you ship everything above; the duplicate file is already drifting.

**Bigger bets to schedule after the spine lands:** D1 (pluggable executors, **L** — biggest strategic differentiator but gate all routing/resume on `profile==='claude'`), B2 (live attach, **L**), G1 (dev-server preview, **L**), then A2/E1/E4 (**M** each).
