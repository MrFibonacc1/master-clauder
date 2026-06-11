/**
 * Fastify HTTP + WebSocket server: JSON API over the hub's store/brain,
 * live event stream over /ws, static dashboard bundle at /.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { CortexEvent } from '../shared/types.js';
import type { Hub } from './hub.js';

/** The subset of Hub the server needs (lets tests pass a stub). */
export interface HubLike {
  status(): unknown;
  store: Hub['store'];
  brain: {
    search(q: string, opts: { k: number }): Promise<unknown>;
    listNotes(filter?: unknown): Promise<unknown> | unknown;
    pinNote(relPath: string, pinned: boolean): Promise<unknown> | unknown;
    deleteNote(relPath: string): Promise<unknown> | unknown;
  };
  agents?: {
    pause(agentId: string): unknown;
    resume(agentId: string): unknown;
    kill(agentId: string): unknown;
  };
}

const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Cortex</title>
<style>body{background:#0d0e14;color:#aab;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
code{color:#7df;background:#181a24;padding:2px 8px;border-radius:6px}</style></head>
<body><div><h1>Cortex dashboard not built</h1><p>Run <code>pnpm --dir dashboard build</code> then restart.</p></div></body></html>`;

export async function startServer(hub: HubLike, port: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  const here = path.dirname(fileURLToPath(import.meta.url));
  // works from src/ (tsx) and dist/ alike: repo root is two levels up
  const distDir = path.resolve(here, '../../dashboard/dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: distDir, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(FALLBACK_HTML));
  }

  // ---- REST API ----
  app.get('/api/status', async () => hub.status());
  app.get('/api/tasks', async () => hub.store.listTasks());
  app.get('/api/agents', async () => hub.store.listAgents());
  app.get('/api/events', async (req) => {
    const since = Number((req.query as Record<string, string>).since ?? 0);
    return hub.store.eventsSince(Number.isFinite(since) ? since : 0);
  });
  app.get('/api/costs', async () => hub.store.costSummary());
  app.get('/api/merge-queue', async () => hub.store.listMergeQueue());

  app.get('/api/memory', async (req) => {
    const q = (req.query as Record<string, string>).q;
    if (q) return hub.brain.search(q, { k: 20 });
    return hub.brain.listNotes();
  });
  app.post('/api/memory/pin', async (req) => {
    const { relPath, pinned } = req.body as { relPath: string; pinned: boolean };
    await hub.brain.pinNote(relPath, pinned);
    return { ok: true };
  });
  app.delete('/api/memory', async (req) => {
    const { relPath } = req.body as { relPath: string };
    await hub.brain.deleteNote(relPath);
    return { ok: true };
  });

  for (const action of ['pause', 'resume', 'kill'] as const) {
    app.post(`/api/agents/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      await hub.agents?.[action](id);
      return { ok: true };
    });
  }

  // ---- WebSocket live stream ----
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => {
      socket.send(JSON.stringify({ type: 'snapshot', status: hub.status() }));
      const onEvent = (event: CortexEvent): void => {
        try {
          socket.send(JSON.stringify({ type: 'event', event }));
        } catch {
          /* socket gone */
        }
      };
      hub.store.on('event', onEvent);
      socket.on('close', () => hub.store.off('event', onEvent));
    });
  });

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}
