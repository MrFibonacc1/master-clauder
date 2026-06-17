import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CoordinationStore } from '../core/store.js';
import { startServer, type HubLike } from './server.js';

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
