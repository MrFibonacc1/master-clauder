/**
 * AgentManager — hub-side lifecycle of agent child processes: spawn with
 * concurrency limits, NDJSON stdout parsing into the coordination store,
 * pause/resume/kill via stdin, log teeing, crash reaping.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { CoordinationStore } from '../core/store.js';
import type { AgentRecord, AgentToHubMsg, Autonomy, HubToAgentMsg } from '../shared/types.js';

export interface AgentSpawnSpec {
  agentId: string;
  name: string;
  taskId: string;
  repo: string;
  repoPath: string;
  model: string;
  prompt: string;
  memoryContext: string;
  autonomy: Autonomy;
  ownership: string[];
  worktree: { worktreePath: string; branch: string };
  resumeSessionId?: string;
}

export interface AgentResult {
  success: boolean;
  summary: string;
}

interface RunningAgent {
  child: ChildProcess;
  record: AgentRecord;
  log: WriteStream;
  doneEmitted: boolean;
}

const KILL_GRACE_MS = 5000;

export class AgentManager {
  private running = new Map<string, RunningAgent>();
  private queue: (() => void)[] = [];
  /** Last cumulative cost (USD) seen per SDK session, for per-turn delta accounting. */
  private sessionCost = new Map<string, number>();

  constructor(
    private store: CoordinationStore,
    private opts: { concurrency: number; runnerPath: string; logsDir: string },
  ) {
    mkdirSync(opts.logsDir, { recursive: true });
  }

  activeCount(): number {
    return this.running.size;
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentResult> {
    if (this.running.size >= this.opts.concurrency) {
      await new Promise<void>((res) => this.queue.push(res));
    }
    return this.doSpawn(spec);
  }

  private doSpawn(spec: AgentSpawnSpec): Promise<AgentResult> {
    const record: AgentRecord = {
      id: spec.agentId,
      name: spec.name,
      taskId: spec.taskId,
      repo: spec.repo,
      worktreePath: spec.worktree.worktreePath,
      branch: spec.worktree.branch,
      model: spec.model,
      status: 'starting',
      sdkSessionId: spec.resumeSessionId,
      startedAt: Date.now(),
    };

    const configPath = path.join(os.tmpdir(), `cortex-agent-${spec.agentId}.json`);
    writeFileSync(
      configPath,
      JSON.stringify({
        agentId: spec.agentId,
        taskId: spec.taskId,
        model: spec.model,
        worktreePath: spec.worktree.worktreePath,
        prompt: spec.prompt,
        memoryContext: spec.memoryContext,
        autonomy: spec.autonomy,
        sdkSessionId: spec.resumeSessionId,
      }),
    );

    const runner = this.opts.runnerPath;
    const cmd = runner.endsWith('.ts') ? 'npx' : process.execPath;
    const args = runner.endsWith('.ts') ? ['tsx', runner, configPath] : [runner, configPath];
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    record.pid = child.pid;
    this.store.upsertAgent(record);
    this.store.append({
      ts: Date.now(),
      type: 'agent.spawned',
      agentId: spec.agentId,
      taskId: spec.taskId,
      payload: { name: spec.name, model: spec.model, branch: spec.worktree.branch },
    });

    const log = createWriteStream(path.join(this.opts.logsDir, `${spec.agentId}.jsonl`), { flags: 'a' });
    const ra: RunningAgent = { child, record, log, doneEmitted: false };
    this.running.set(spec.agentId, ra);

    return new Promise<AgentResult>((resolve) => {
      const finish = (result: AgentResult): void => {
        if (ra.doneEmitted) return;
        ra.doneEmitted = true;
        resolve(result);
      };

      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        log.write(line + '\n');
        let msg: AgentToHubMsg;
        try {
          msg = JSON.parse(line) as AgentToHubMsg;
        } catch {
          return;
        }
        this.handleMsg(ra, msg, finish);
      });
      child.stderr?.on('data', (d: Buffer) => log.write(d));

      child.on('exit', (code) => {
        log.end();
        this.running.delete(spec.agentId);
        if (!ra.doneEmitted) {
          // Crashed without 'done' — reap.
          ra.record.status = 'failed';
          this.store.upsertAgent(ra.record);
          this.store.releaseClaims(spec.agentId);
          this.store.append({
            ts: Date.now(),
            type: 'agent.status',
            agentId: spec.agentId,
            taskId: spec.taskId,
            payload: { status: 'failed', reason: `exited with code ${code} without done message` },
          });
          finish({ success: false, summary: `agent exited unexpectedly (code ${code})` });
        }
        this.queue.shift()?.();
      });

      child.on('error', (err) => {
        ra.record.status = 'failed';
        this.store.upsertAgent(ra.record);
        this.store.releaseClaims(spec.agentId);
        finish({ success: false, summary: `spawn error: ${err.message}` });
      });
    });
  }

  private handleMsg(ra: RunningAgent, msg: AgentToHubMsg, finish: (r: AgentResult) => void): void {
    const { record } = ra;
    const base = { ts: Date.now(), agentId: record.id, taskId: record.taskId };
    switch (msg.kind) {
      case 'session':
        record.sdkSessionId = msg.sdkSessionId;
        record.status = 'working';
        this.store.upsertAgent(record);
        this.store.append({ ...base, type: 'agent.status', payload: { status: 'working', sdkSessionId: msg.sdkSessionId } });
        break;
      case 'status':
        record.status = msg.status;
        this.store.upsertAgent(record);
        this.store.append({ ...base, type: 'agent.status', payload: { status: msg.status, detail: msg.detail } });
        break;
      case 'message':
        this.store.append({ ...base, type: 'agent.message', payload: { text: msg.text } });
        break;
      case 'tool':
        this.store.append({ ...base, type: 'agent.tool', payload: { name: msg.name, summary: msg.summary } });
        break;
      case 'usage': {
        // The SDK reports total_cost_usd cumulatively per session. On a resumed
        // (escalated) session the cumulative includes earlier turns, so record only
        // the delta since we last saw this session to avoid double-counting cost.
        const sid = record.sdkSessionId;
        let cost = msg.usage.costUsd;
        if (sid) {
          const prev = this.sessionCost.get(sid) ?? 0;
          const delta = Math.max(0, cost - prev);
          this.sessionCost.set(sid, Math.max(prev, cost));
          cost = delta;
        }
        const usage = { ...msg.usage, costUsd: cost };
        this.store.append({ ...base, type: 'agent.usage', payload: { ...usage } });
        this.store.recordUsage({ ...usage, taskId: record.taskId, agentId: record.id, ts: Date.now() });
        break;
      }
      case 'memory':
        this.store.append({ ...base, type: 'agent.memory', payload: { op: msg.op, relPath: msg.relPath } });
        break;
      case 'done':
        record.status = msg.success ? 'done' : 'failed';
        this.store.upsertAgent(record);
        this.store.append({ ...base, type: 'agent.status', payload: { status: record.status, summary: msg.summary } });
        finish({ success: msg.success, summary: msg.summary });
        break;
      default:
        break;
    }
  }

  private sendToAgent(agentId: string, msg: HubToAgentMsg): boolean {
    const ra = this.running.get(agentId);
    if (!ra || !ra.child.stdin?.writable) return false;
    ra.child.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  pause(agentId: string): void {
    if (this.sendToAgent(agentId, { kind: 'pause' })) {
      const ra = this.running.get(agentId)!;
      ra.record.status = 'paused';
      this.store.upsertAgent(ra.record);
      this.store.append({ ts: Date.now(), type: 'agent.status', agentId, taskId: ra.record.taskId, payload: { status: 'paused' } });
    }
  }

  resume(agentId: string): void {
    if (this.sendToAgent(agentId, { kind: 'resume' })) {
      const ra = this.running.get(agentId)!;
      ra.record.status = 'working';
      this.store.upsertAgent(ra.record);
      this.store.append({ ts: Date.now(), type: 'agent.status', agentId, taskId: ra.record.taskId, payload: { status: 'working' } });
    }
  }

  kill(agentId: string): void {
    const ra = this.running.get(agentId);
    if (!ra) return;
    this.sendToAgent(agentId, { kind: 'kill' });
    const timer = setTimeout(() => {
      if (!ra.child.killed && ra.child.exitCode === null) ra.child.kill('SIGTERM');
    }, KILL_GRACE_MS);
    timer.unref();
    ra.record.status = 'killed';
    this.store.upsertAgent(ra.record);
    this.store.releaseClaims(agentId);
    this.store.append({ ts: Date.now(), type: 'agent.status', agentId, taskId: ra.record.taskId, payload: { status: 'killed' } });
  }

  pauseAll(): void {
    for (const id of this.running.keys()) this.pause(id);
  }
}
