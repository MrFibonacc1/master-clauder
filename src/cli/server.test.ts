import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const hub: HubLike = {
  status: () => ({ tasks: [], agents: [], costs: { byTask: {}, byAgent: {}, total: 0 } }),
  store,
  brain: fakeBrain,
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
});
