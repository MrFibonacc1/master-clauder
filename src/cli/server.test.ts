import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CoordinationStore } from '../core/store.js';
import { startServer, buildResumeCommand, type HubLike } from './server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
const store = new CoordinationStore(path.join(tmp, 'state.db'));

const fakeBrain: HubLike['brain'] = {
  search: async () => [],
  listNotes: () => [],
  pinNote: () => undefined,
  deleteNote: () => undefined,
};

const dispatchSpy = vi.fn(async (title: string, repo: string, opts?: { model?: string; maxModel?: string }) => ({
  id: 'task_1',
  title,
  repo,
  status: 'pending',
  ...opts,
}));

const hub: HubLike = {
  status: () => ({ tasks: [], agents: [], costs: { byTask: {}, byAgent: {}, total: 0 } }),
  store,
  brain: fakeBrain,
  config: { repos: { app: { name: 'app', path: '/repos/app' } } },
  dispatchTask: dispatchSpy,
};

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  app = await startServer(hub, 0);
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await app.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('server', () => {
  it('GET /api/status returns the hub status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });

  it('GET /api/events returns appended events', async () => {
    store.append({ ts: Date.now(), type: 'task.created', taskId: 't1', payload: { title: 'hello' } });
    const res = await fetch(`http://127.0.0.1:${port}/api/events?since=0`);
    const events = (await res.json()) as { type: string; taskId: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'task.created' && e.taskId === 't1')).toBe(true);
  });

  it('WS sends a snapshot then forwards live events', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: { type: string; event?: { type: string } }[] = [];
    const got = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ws event')), 5000);
      ws.addEventListener('message', (m) => {
        messages.push(JSON.parse(String(m.data)));
        if (messages.length === 1) {
          store.append({ ts: Date.now(), type: 'agent.message', agentId: 'a1', payload: { text: 'hi' } });
        }
        if (messages.some((x) => x.type === 'event')) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${String(e)}`));
      });
    });
    await got;
    ws.close();
    expect(messages[0].type).toBe('snapshot');
    const evt = messages.find((m) => m.type === 'event');
    expect(evt?.event?.type).toBe('agent.message');
  });

  it('GET /api/repos returns the registered repos', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/repos`);
    expect(res.status).toBe(200);
    const repos = (await res.json()) as { name: string; path: string }[];
    expect(repos).toEqual([{ name: 'app', path: '/repos/app' }]);
  });

  it('POST /api/tasks dispatches and returns the task', async () => {
    dispatchSpy.mockClear();
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'add dark mode', repo: 'app', model: 'claude-x', maxModel: 'top' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; task: { title: string } };
    expect(body.ok).toBe(true);
    expect(body.task.title).toBe('add dark mode');
    expect(dispatchSpy).toHaveBeenCalledWith('add dark mode', 'app', { model: 'claude-x', maxModel: 'top' });
  });

  it('POST /api/tasks resolves the sole registered repo when none given', async () => {
    dispatchSpy.mockClear();
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'tidy up' }),
    });
    expect(res.status).toBe(200);
    expect(dispatchSpy).toHaveBeenCalledWith('tidy up', 'app', { model: undefined, maxModel: undefined });
  });

  it('POST /api/tasks with no title returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'app' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'title required' });
  });

  it('GET /api/repos/:name/agents returns the repo agents with mapped shape', async () => {
    const startedAt = Date.now();
    store.upsertTask({
      id: 'task_sess',
      title: 'wire up sessions',
      status: 'running',
      tier: 'mid',
      model: 'claude-mid',
      repo: 'app',
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    store.upsertAgent({
      id: 'agent_sess',
      name: 'agent-sess',
      taskId: 'task_sess',
      repo: 'app',
      worktreePath: '/tmp/worktrees/agent_sess',
      branch: 'cortex/agent-sess',
      model: 'claude-mid',
      status: 'working',
      sdkSessionId: 'sdk-abc-123',
      startedAt,
    });
    // An agent on a different repo should be filtered out.
    store.upsertAgent({
      id: 'agent_other',
      name: 'agent-other',
      taskId: 'task_sess',
      repo: 'web',
      model: 'claude-mid',
      status: 'done',
      startedAt: startedAt - 1000,
    });
    store.recordUsage({
      taskId: 'task_sess',
      agentId: 'agent_sess',
      model: 'claude-mid',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.42,
      ts: startedAt,
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/repos/app/agents`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as {
      id: string;
      sdkSessionId?: string;
      worktreePath?: string;
      taskTitle: string;
      cost: number;
    }[];
    const found = agents.find((a) => a.id === 'agent_sess');
    expect(found).toBeTruthy();
    expect(found?.sdkSessionId).toBe('sdk-abc-123');
    expect(found?.worktreePath).toBe('/tmp/worktrees/agent_sess');
    expect(found?.taskTitle).toBe('wire up sessions');
    expect(found?.cost).toBe(0.42);
    expect(agents.some((a) => a.id === 'agent_other')).toBe(false);
  });

  it('buildResumeCommand builds a copy-paste-safe resume command', () => {
    expect(buildResumeCommand('/tmp/wt', 'sid-9')).toBe("cd '/tmp/wt' && claude --resume sid-9");
    expect(buildResumeCommand('/tmp/wt')).toBe("cd '/tmp/wt'");
    // Single quotes in the path are escaped so the shell command stays valid.
    expect(buildResumeCommand("/tmp/it's here")).toBe("cd '/tmp/it'\\''s here'");
  });

  it('POST /api/sessions/:id/open-terminal returns ok:false for a missing agent', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/nope/open-terminal`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'agent not found' });
  });

  // The success path (agent with worktree + sdkSessionId -> ok:true, command
  // contains `claude --resume <sid>` and the worktree path) is covered by the
  // buildResumeCommand unit test above so the suite never launches a terminal.
});

describe('server with multiple repos', () => {
  let multiApp: FastifyInstance;
  let multiPort: number;
  const multiStore = new CoordinationStore(path.join(tmp, 'state-multi.db'));

  beforeAll(async () => {
    const multiHub: HubLike = {
      status: () => ({ tasks: [], agents: [], costs: { byTask: {}, byAgent: {}, total: 0 } }),
      store: multiStore,
      brain: fakeBrain,
      config: {
        repos: {
          app: { name: 'app', path: '/repos/app' },
          web: { name: 'web', path: '/repos/web' },
        },
      },
      dispatchTask: vi.fn(async () => ({ id: 'task_2' })),
    };
    multiApp = await startServer(multiHub, 0);
    const addr = multiApp.server.address();
    multiPort = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await multiApp.close();
    multiStore.close();
  });

  it('POST /api/tasks with no repo and multiple repos returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${multiPort}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'do something' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'repo required (multiple repos registered)' });
  });
});

describe('server review-before-merge (A1)', () => {
  let reviewApp: FastifyInstance;
  let reviewPort: number;
  const reviewStore = new CoordinationStore(path.join(tmp, 'state-review.db'));

  const review = {
    agentId: 'agent_rev',
    agentName: 'agent-rev',
    taskId: 'task_rev',
    taskTitle: 'add a flag',
    repo: 'app',
    branch: 'agent/agent-rev/add-a-flag',
    model: 'claude-mid',
    summary: 'added the flag',
    parkedAt: 1000,
  };

  const approveSpy = vi.fn((id: string) => id === review.agentId);
  const requestChangesSpy = vi.fn((id: string, _comments: string) => id === review.agentId);

  const reviewGit: HubLike['git'] = {
    diffAgainstMain: async () => 'diff --git a/x b/x\n+hello\n',
    changedFiles: async () => ['x'],
    diffStat: async () => [{ file: 'x', additions: 1, deletions: 0 }],
  };

  beforeAll(async () => {
    const reviewHub: HubLike = {
      status: () => ({ tasks: [], agents: [], costs: { byTask: {}, byAgent: {}, total: 0 } }),
      store: reviewStore,
      brain: fakeBrain,
      config: { repos: { app: { name: 'app', path: '/repos/app' } } },
      listReviews: () => [review],
      reviewWorktree: (id) =>
        id === review.agentId ? { worktreePath: '/tmp/wt/agent_rev', mainBranch: 'main' } : undefined,
      approveReview: approveSpy,
      requestChanges: requestChangesSpy,
      git: reviewGit,
    };
    reviewApp = await startServer(reviewHub, 0);
    const addr = reviewApp.server.address();
    reviewPort = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await reviewApp.close();
    reviewStore.close();
  });

  it('GET /api/reviews returns the parked reviews', async () => {
    const res = await fetch(`http://127.0.0.1:${reviewPort}/api/reviews`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; branch: string }[];
    expect(body).toEqual([review]);
  });

  it('GET /api/agents/:id/diff returns files and patch', async () => {
    const res = await fetch(`http://127.0.0.1:${reviewPort}/api/agents/${review.agentId}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      branch?: string;
      files: { file: string; additions: number; deletions: number }[];
      patch: string;
    };
    expect(body.agentId).toBe(review.agentId);
    expect(body.branch).toBe(review.branch);
    expect(body.files).toEqual([{ file: 'x', additions: 1, deletions: 0 }]);
    expect(body.patch).toContain('+hello');
  });

  it('GET /api/agents/:id/diff returns 404 for an unknown agent', async () => {
    const res = await fetch(`http://127.0.0.1:${reviewPort}/api/agents/nope/diff`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'no review for agent' });
  });

  it('POST /api/agents/:id/review approve calls approveReview and returns ok', async () => {
    approveSpy.mockClear();
    const res = await fetch(`http://127.0.0.1:${reviewPort}/api/agents/${review.agentId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
    expect(approveSpy).toHaveBeenCalledWith(review.agentId);
  });

  it('POST /api/agents/:id/review request-changes without comments returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${reviewPort}/api/agents/${review.agentId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'request-changes' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'comments required' });
  });

  it('POST /api/agents/:id/review approve for unknown agent returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${reviewPort}/api/agents/nope/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'no review for agent' });
  });
});
