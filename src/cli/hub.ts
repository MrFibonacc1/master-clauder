/**
 * Hub — composition root for the cortex CLI process.
 * Wires config, coordination store, brain, git, agents, merge queue,
 * model client and orchestrator together, and implements task dispatch.
 */
import path from 'node:path';
import { loadConfig, repoConfig, statePath, CORTEX_HOME } from '../core/config.js';
import { CoordinationStore } from '../core/store.js';
import type { Autonomy, CortexConfig, PlannedSubtask, RoutingDecision, TaskRecord, Tier } from '../shared/types.js';
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
}

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

    // Fire-and-forget execution; status is observable via store events.
    void this.executeTask(task, rc.path, memoryContext, maxModel, autonomy, decision).catch((err: unknown) => {
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

  private async executeTask(
    task: TaskRecord,
    repoPath: string,
    memoryContext: string,
    maxModel: Tier,
    autonomy: Autonomy,
    decision: RoutingDecision,
  ): Promise<void> {
    if (needsPlanning(task.title)) {
      this.store.setTaskStatus(task.id, 'planning');
      this.store.append({ ts: Date.now(), type: 'task.status', taskId: task.id, payload: { status: 'planning' } });
      const plan = await this.orchestrator.plan(task, memoryContext);
      this.store.setTaskStatus(task.id, 'running');
      const results = await Promise.all(
        plan.subtasks.map((sub) => this.runSubtask(task, sub, repoPath, memoryContext, maxModel, autonomy)),
      );
      const ok = results.every(Boolean);
      this.store.setTaskStatus(task.id, ok ? 'awaiting-merge' : 'failed');
      this.store.append({
        ts: Date.now(),
        type: 'task.status',
        taskId: task.id,
        payload: { status: ok ? 'awaiting-merge' : 'failed' },
      });
    } else {
      this.store.setTaskStatus(task.id, 'running');
      const sub: PlannedSubtask = {
        title: task.title,
        prompt: task.title,
        ownership: ['**'],
        suggestedTier: decision.tier,
      };
      const ok = await this.runSubtask(task, sub, repoPath, memoryContext, maxModel, autonomy, decision.model);
      this.store.setTaskStatus(task.id, ok ? 'awaiting-merge' : 'failed');
      this.store.append({
        ts: Date.now(),
        type: 'task.status',
        taskId: task.id,
        payload: { status: ok ? 'awaiting-merge' : 'failed' },
      });
    }
  }

  /** Run one subtask: worktree + claims + agent spawn + merge submit + memory write. */
  private async runSubtask(
    task: TaskRecord,
    sub: PlannedSubtask,
    repoPath: string,
    memoryContext: string,
    maxModel: Tier,
    autonomy: Autonomy,
    fixedModel?: string,
  ): Promise<boolean> {
    const agentId = genId('agent');
    const agentName = `agent-${agentId.slice(-6)}`;
    const slug = slugify(sub.title) || 'task';
    let tier = sub.suggestedTier;
    let model = fixedModel ?? modelForTier(tier).id;

    // Acquire claims, waiting if conflicting claims are active.
    const acquired = await this.waitForClaims(agentId, task.repo, sub.ownership, task.id);
    if (!acquired) return false;

    const { worktreePath, branch } = await this.git.createWorktree(repoPath, task.repo, agentName, slug);

    const digest = digestRecentEvents(this.store, task.repo);
    const spawnOnce = async (resumeSessionId?: string): Promise<{ success: boolean; summary: string }> =>
      this.agents.spawn({
        agentId,
        name: agentName,
        taskId: task.id,
        repo: task.repo,
        repoPath,
        model,
        prompt: digest ? `${sub.prompt}\n\nRecent activity in this repo:\n${digest}` : sub.prompt,
        memoryContext,
        autonomy,
        ownership: sub.ownership,
        worktree: { worktreePath, branch },
        resumeSessionId,
      });

    try {
      let result = await spawnOnce();

      if (!result.success) {
        // Escalation: bump one tier and respawn once, resuming the SDK session.
        const next = escalate(tier, maxModel);
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

      if (result.success) {
        this.store.submitMerge({ branch, taskId: task.id, agentId, repo: task.repo });
        await this.brain.taskLog(task.repo, sub.title, 'success', result.summary);
      } else {
        await this.brain.taskLog(task.repo, sub.title, 'failure', result.summary);
      }
      return result.success;
    } finally {
      this.store.releaseClaims(agentId);
    }
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
