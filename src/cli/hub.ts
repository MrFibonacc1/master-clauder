/**
 * Hub — composition root for the cortex CLI process.
 * Wires config, coordination store, brain, git, agents, merge queue,
 * model client and orchestrator together, and implements task dispatch.
 */
import path from 'node:path';
import { loadConfig, repoConfig, statePath, CORTEX_HOME } from '../core/config.js';
import { CoordinationStore } from '../core/store.js';
import type {
  Autonomy,
  CortexConfig,
  PlannedSubtask,
  ReviewInfo,
  RoutingDecision,
  TaskRecord,
  TaskStatus,
  Tier,
} from '../shared/types.js';
import { routeTask, escalate } from '../core/router.js';
import { ModelClient } from '../core/modelClient.js';
import { CliModelClient } from '../core/cliClient.js';
import { Brain } from '../core/brain.js';
import { GitManager } from '../orchestration/git.js';
import { AgentManager } from '../orchestration/agentManager.js';
import { MergeQueue } from '../orchestration/mergeQueue.js';
import { Orchestrator, needsPlanning, digestRecentEvents } from '../orchestration/orchestrator.js';
import { modelForTier } from '../core/models.js';

export interface DispatchOpts {
  model?: string;
  maxModel?: Tier;
  autonomy?: Autonomy;
  reviewBeforeMerge?: boolean;
}

/** Shared per-task execution context threaded through executeTask/runSubtask. */
interface ExecCtx {
  repoPath: string;
  mainBranch: string;
  memoryContext: string;
  maxModel: Tier;
  autonomy: Autonomy;
  review: boolean;
}

/** A finished agent held awaiting human review, with enough state to resume it. */
interface ParkedReview {
  agentId: string;
  agentName: string;
  taskId: string;
  repo: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  model: string;
  subTitle: string;
  subPrompt: string;
  memoryContext: string;
  autonomy: Autonomy;
  ownership: string[];
  summary: string;
  parkedAt: number;
}

type SubtaskOutcome = 'merged' | 'failed' | 'parked';

let seq = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const CLAIM_POLL_MS = 2000;
const CLAIM_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export class Hub {
  config: CortexConfig;
  store: CoordinationStore;
  brain: Brain;
  git: GitManager;
  agents: AgentManager;
  mergeQueue: MergeQueue;
  modelClient: ModelClient | CliModelClient;
  orchestrator: Orchestrator;

  constructor(config?: CortexConfig) {
    this.config = config ?? loadConfig();
    this.store = new CoordinationStore(statePath());
    this.brain = new Brain(this.config.vaultPath);
    this.git = new GitManager();
    this.agents = new AgentManager(this.store, {
      concurrency: this.config.concurrency,
      runnerPath: path.join(path.dirname(new URL(import.meta.url).pathname), '../orchestration/agentRunner.js'),
      logsDir: path.join(CORTEX_HOME, 'logs'),
    });
    // Prefer the user's Claude Code subscription (headless `claude -p`) when no
    // API key is set; fall back to the direct API client otherwise.
    this.modelClient = process.env.ANTHROPIC_API_KEY
      ? new ModelClient(this.store, this.config.budget)
      : new CliModelClient(this.store, this.config.budget);
    this.mergeQueue = new MergeQueue(this.store, this.git, this.config.repos);
    this.orchestrator = new Orchestrator({
      store: this.store,
      modelClientLike: this.modelClient,
      plannerModel: modelForTier(this.config.maxModel).id,
    });
  }

  async init(): Promise<void> {
    await this.brain.ensureVault();
    this.brain.watch();
    this.mergeQueue.run();
  }

  // ---------------------------------------------------------------- dispatch

  async dispatchTask(title: string, repoName: string, opts: DispatchOpts = {}): Promise<TaskRecord> {
    const rc = repoConfig(this.config, repoName);
    if (!rc) throw new Error(`Unknown repo "${repoName}". Run \`cortex init <path>\` first.`);

    const maxModel: Tier = opts.maxModel ?? rc.maxModel ?? this.config.maxModel;
    const autonomy: Autonomy = opts.autonomy ?? rc.autonomy ?? this.config.autonomy;
    const review: boolean = opts.reviewBeforeMerge ?? rc.reviewBeforeMerge ?? this.config.reviewBeforeMerge;
    const mainBranch = rc.mainBranch ?? 'main';
    const taskId = genId('task');

    const decision = await routeTask({
      taskId,
      title,
      repoName,
      maxModel,
      defaultTier: this.config.defaultTier,
      override: opts.model,
      client: this.modelClient,
    });

    const now = Date.now();
    const task: TaskRecord = {
      id: taskId,
      title,
      status: 'pending',
      tier: decision.tier,
      model: decision.model,
      repo: repoName,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertTask(task);
    this.store.append({ ts: now, type: 'task.created', taskId, payload: { title, repo: repoName } });
    this.store.recordRouting(decision);
    this.store.append({
      ts: Date.now(),
      type: 'task.routed',
      taskId,
      payload: { tier: decision.tier, model: decision.model, reason: decision.reason, source: decision.source },
    });

    const retrieval = await this.brain.retrieveForTask(title, repoName, 6);
    const memoryContext = retrieval.hits.length ? retrieval.renderContext(retrieval.hits) : '';

    const ctx: ExecCtx = { repoPath: rc.path, mainBranch, memoryContext, maxModel, autonomy, review };
    // Fire-and-forget execution; status is observable via store events.
    void this.executeTask(task, ctx, decision).catch((err: unknown) => {
      this.store.setTaskStatus(taskId, 'failed');
      this.store.append({
        ts: Date.now(),
        type: 'task.status',
        taskId,
        payload: { status: 'failed', error: err instanceof Error ? err.message : String(err) },
      });
    });

    return task;
  }

  private async executeTask(task: TaskRecord, ctx: ExecCtx, decision: RoutingDecision): Promise<void> {
    let outcomes: SubtaskOutcome[];
    if (needsPlanning(task.title)) {
      this.store.setTaskStatus(task.id, 'planning');
      this.store.append({ ts: Date.now(), type: 'task.status', taskId: task.id, payload: { status: 'planning' } });
      const plan = await this.orchestrator.plan(task, ctx.memoryContext);
      this.store.setTaskStatus(task.id, 'running');
      outcomes = await Promise.all(plan.subtasks.map((sub) => this.runSubtask(task, sub, ctx)));
    } else {
      this.store.setTaskStatus(task.id, 'running');
      const sub: PlannedSubtask = { title: task.title, prompt: task.title, ownership: ['**'], suggestedTier: decision.tier };
      outcomes = [await this.runSubtask(task, sub, ctx, decision.model)];
    }
    this.setTaskFromOutcomes(task.id, outcomes);
  }

  private setTaskFromOutcomes(taskId: string, outcomes: SubtaskOutcome[]): void {
    let status: TaskStatus;
    if (outcomes.includes('parked')) status = 'needs-review';
    else if (outcomes.length > 0 && outcomes.every((o) => o === 'merged')) status = 'awaiting-merge';
    else status = 'failed';
    this.store.setTaskStatus(taskId, status);
    this.store.append({ ts: Date.now(), type: 'task.status', taskId, payload: { status } });
  }

  /** Run one subtask: worktree + claims + agent spawn, then merge or park for review. */
  private async runSubtask(
    task: TaskRecord,
    sub: PlannedSubtask,
    ctx: ExecCtx,
    fixedModel?: string,
  ): Promise<SubtaskOutcome> {
    const agentId = genId('agent');
    const agentName = `agent-${agentId.slice(-6)}`;
    const slug = slugify(sub.title) || 'task';
    let tier = sub.suggestedTier;
    let model = fixedModel ?? modelForTier(tier).id;

    // Acquire claims, waiting if conflicting claims are active.
    const acquired = await this.waitForClaims(agentId, task.repo, sub.ownership, task.id);
    if (!acquired) return 'failed';

    const { worktreePath, branch } = await this.git.createWorktree(
      ctx.repoPath,
      task.repo,
      agentName,
      slug,
      ctx.mainBranch,
    );

    const digest = digestRecentEvents(this.store, task.repo);
    const basePrompt = digest ? `${sub.prompt}\n\nRecent activity in this repo:\n${digest}` : sub.prompt;
    const spawnOnce = async (resumeSessionId?: string): Promise<{ success: boolean; summary: string }> =>
      this.agents.spawn({
        agentId,
        name: agentName,
        taskId: task.id,
        repo: task.repo,
        repoPath: ctx.repoPath,
        model,
        prompt: basePrompt,
        memoryContext: ctx.memoryContext,
        autonomy: ctx.autonomy,
        ownership: sub.ownership,
        worktree: { worktreePath, branch },
        resumeSessionId,
      });

    let result = await spawnOnce();

    if (!result.success) {
      // Escalation: bump one tier and respawn once, resuming the SDK session.
      const next = escalate(tier, ctx.maxModel);
      if (next !== null && next !== tier) {
        tier = next;
        model = modelForTier(tier).id;
        const esc: RoutingDecision = {
          taskId: task.id,
          tier,
          model,
          reason: `escalated after agent failure: ${result.summary.slice(0, 200)}`,
          source: 'escalation',
          ts: Date.now(),
        };
        this.store.recordRouting(esc);
        this.store.append({
          ts: Date.now(),
          type: 'task.routed',
          taskId: task.id,
          agentId,
          payload: { tier, model, reason: esc.reason, source: 'escalation' },
        });
        const sessionId = this.store.getAgent(agentId)?.sdkSessionId;
        result = await spawnOnce(sessionId);
      }
    }

    if (!result.success) {
      await this.brain.taskLog(task.repo, sub.title, 'failure', result.summary);
      this.store.releaseClaims(agentId);
      return 'failed';
    }

    await this.brain.taskLog(task.repo, sub.title, 'success', result.summary);
    if (ctx.review) {
      // Park for human review — keep claims + worktree until approved or changes requested.
      this.park(
        {
          agentId,
          agentName,
          taskId: task.id,
          repo: task.repo,
          repoPath: ctx.repoPath,
          worktreePath,
          branch,
          model,
          subTitle: sub.title,
          subPrompt: basePrompt,
          memoryContext: ctx.memoryContext,
          autonomy: ctx.autonomy,
          ownership: sub.ownership,
          summary: result.summary,
          parkedAt: Date.now(),
        },
        result.summary,
      );
      return 'parked';
    }

    this.store.submitMerge({ branch, taskId: task.id, agentId, repo: task.repo });
    this.store.releaseClaims(agentId);
    return 'merged';
  }

  // ---------------------------------------------------------------- review (A1)

  private park(pr: ParkedReview, summary: string): void {
    this.store.saveReview(pr.agentId, { ...pr, summary, parkedAt: Date.now() } as unknown as Record<string, unknown>);
    const a = this.store.getAgent(pr.agentId);
    if (a) {
      a.status = 'needs-review';
      this.store.upsertAgent(a);
    }
    this.store.append({ ts: Date.now(), type: 'agent.status', agentId: pr.agentId, taskId: pr.taskId, payload: { status: 'needs-review' } });
    this.store.append({
      ts: Date.now(),
      type: 'approval.requested',
      agentId: pr.agentId,
      taskId: pr.taskId,
      payload: { branch: pr.branch, summary: summary.slice(0, 200) },
    });
  }

  private getParked(agentId: string): ParkedReview | undefined {
    return this.store.getReview(agentId) as unknown as ParkedReview | undefined;
  }

  /** Reviews currently awaiting a human decision (durable, cross-process). */
  listReviews(): ReviewInfo[] {
    return (this.store.listReviews() as unknown as ParkedReview[]).map((pr) => ({
      agentId: pr.agentId,
      agentName: pr.agentName,
      taskId: pr.taskId,
      taskTitle: this.store.getTask(pr.taskId)?.title ?? '',
      repo: pr.repo,
      branch: pr.branch,
      model: pr.model,
      summary: pr.summary,
      parkedAt: pr.parkedAt,
    }));
  }

  /** The worktree path of a parked agent (for computing its diff). */
  reviewWorktree(agentId: string): { worktreePath: string; mainBranch: string } | undefined {
    const pr = this.getParked(agentId);
    if (!pr) return undefined;
    const main = repoConfig(this.config, pr.repo)?.mainBranch ?? 'main';
    return { worktreePath: pr.worktreePath, mainBranch: main };
  }

  /** Approve a parked review → submit the branch to the merge queue. */
  approveReview(agentId: string): boolean {
    const pr = this.getParked(agentId);
    if (!pr) return false;
    this.store.deleteReview(agentId);
    this.store.submitMerge({ branch: pr.branch, taskId: pr.taskId, agentId, repo: pr.repo });
    this.store.releaseClaims(agentId);
    const a = this.store.getAgent(agentId);
    if (a) {
      a.status = 'done';
      this.store.upsertAgent(a);
    }
    this.store.append({ ts: Date.now(), type: 'approval.resolved', agentId, taskId: pr.taskId, payload: { decision: 'approve' } });
    this.store.setTaskStatus(pr.taskId, 'awaiting-merge');
    this.store.append({ ts: Date.now(), type: 'task.status', taskId: pr.taskId, payload: { status: 'awaiting-merge' } });
    return true;
  }

  /** Request changes on a parked review → resume the agent with the feedback. */
  requestChanges(agentId: string, comments: string): boolean {
    const pr = this.getParked(agentId);
    if (!pr) return false;
    this.store.deleteReview(agentId);
    this.store.append({
      ts: Date.now(),
      type: 'approval.resolved',
      agentId,
      taskId: pr.taskId,
      payload: { decision: 'request-changes', comments: comments.slice(0, 500) },
    });
    const a = this.store.getAgent(agentId);
    if (a) {
      a.status = 'working';
      this.store.upsertAgent(a);
    }
    this.store.setTaskStatus(pr.taskId, 'running');
    this.store.append({ ts: Date.now(), type: 'task.status', taskId: pr.taskId, payload: { status: 'running' } });

    const resumeSessionId = this.store.getAgent(agentId)?.sdkSessionId;
    const prompt = `${pr.subPrompt}\n\nA reviewer requested changes:\n${comments}\n\nAddress the feedback in your worktree and commit.`;
    void this.agents
      .spawn({
        agentId: pr.agentId,
        name: pr.agentName,
        taskId: pr.taskId,
        repo: pr.repo,
        repoPath: pr.repoPath,
        model: pr.model,
        prompt,
        memoryContext: pr.memoryContext,
        autonomy: pr.autonomy,
        ownership: pr.ownership,
        worktree: { worktreePath: pr.worktreePath, branch: pr.branch },
        resumeSessionId,
      })
      .then(async (result) => {
        if (result.success) {
          await this.brain.taskLog(pr.repo, pr.subTitle, 'success', result.summary);
          this.park(pr, result.summary);
          this.setTaskFromOutcomes(pr.taskId, ['parked']);
        } else {
          await this.brain.taskLog(pr.repo, pr.subTitle, 'failure', result.summary);
          this.store.releaseClaims(agentId);
          const ag = this.store.getAgent(agentId);
          if (ag) {
            ag.status = 'failed';
            this.store.upsertAgent(ag);
          }
          this.setTaskFromOutcomes(pr.taskId, ['failed']);
        }
      })
      .catch(() => this.store.releaseClaims(agentId));
    return true;
  }

  private async waitForClaims(agentId: string, repo: string, globs: string[], taskId: string): Promise<boolean> {
    const deadline = Date.now() + CLAIM_WAIT_TIMEOUT_MS;
    let warned = false;
    while (Date.now() < deadline) {
      if (this.store.tryAcquireClaims(agentId, repo, globs)) return true;
      if (!warned) {
        warned = true;
        this.store.append({
          ts: Date.now(),
          type: 'task.status',
          taskId,
          agentId,
          payload: { status: 'blocked', reason: 'waiting for conflicting path claims to release', globs },
        });
      }
      await new Promise((r) => setTimeout(r, CLAIM_POLL_MS));
    }
    return false;
  }

  // ---------------------------------------------------------------- status

  status(): {
    tasks: TaskRecord[];
    agents: ReturnType<CoordinationStore['listAgents']>;
    costs: ReturnType<CoordinationStore['costSummary']>;
    daySpendUsd: number;
    budget: CortexConfig['budget'];
    mergeQueue: ReturnType<CoordinationStore['listMergeQueue']>;
  } {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return {
      tasks: this.store.listTasks(),
      agents: this.store.listAgents(true),
      costs: this.store.costSummary(),
      daySpendUsd: this.store.costForDay(dayStart.getTime()),
      budget: this.config.budget,
      mergeQueue: this.store.listMergeQueue(),
    };
  }

  async shutdown(): Promise<void> {
    try {
      this.mergeQueue.stop();
    } catch {
      /* ignore */
    }
    try {
      this.agents.pauseAll();
    } catch {
      /* ignore */
    }
    this.store.close();
  }
}
