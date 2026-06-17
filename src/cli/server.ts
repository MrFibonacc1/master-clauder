/**
 * Fastify HTTP + WebSocket server: JSON API over the hub's store/brain,
 * live event stream over /ws, static dashboard bundle at /.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { AgentDiff, CortexEvent, DiffStat, ReviewInfo } from '../shared/types.js';
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
    pauseAll?(): unknown;
  };
  dispatchTask?(
    title: string,
    repo: string,
    opts?: { model?: string; maxModel?: string; autonomy?: string; reviewBeforeMerge?: boolean },
  ): Promise<unknown> | unknown;
  config?: { repos: Record<string, { name: string; path: string }> };
  // ---- review-before-merge (A1) ----
  listReviews?(): ReviewInfo[];
  reviewWorktree?(id: string): { worktreePath: string; mainBranch: string } | undefined;
  approveReview?(id: string): boolean;
  requestChanges?(id: string, comments: string): boolean;
  git?: Hub['git'];
}

/** Cap a diff patch to avoid huge payloads; note when truncated. */
const MAX_PATCH_BYTES = 200 * 1024;
function capPatch(patch: string): string {
  if (patch.length <= MAX_PATCH_BYTES) return patch;
  return `${patch.slice(0, MAX_PATCH_BYTES)}\n... [diff truncated at ${MAX_PATCH_BYTES} bytes]`;
}

const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Cortex</title>
<style>body{background:#0d0e14;color:#aab;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
code{color:#7df;background:#181a24;padding:2px 8px;border-radius:6px}</style></head>
<body><div><h1>Cortex dashboard not built</h1><p>Run <code>pnpm --dir dashboard build</code> then restart.</p></div></body></html>`;

/** Single-quote a path for safe copy-paste into a POSIX shell. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command to drop into an agent's worktree, optionally resuming
 * its Claude Code SDK session. The worktree path is single-quoted so the string
 * is copy-paste-safe.
 */
export function buildResumeCommand(worktreePath: string, sdkSessionId?: string): string {
  const cd = `cd ${shellQuote(worktreePath)}`;
  return sdkSessionId ? `${cd} && claude --resume ${sdkSessionId}` : cd;
}

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

  app.get('/api/repos', async () => {
    if (!hub.config) return [];
    return Object.values(hub.config.repos).map((r) => ({ name: r.name, path: r.path }));
  });

  // ---- review-before-merge (A1) ----
  app.get('/api/reviews', async () => hub.listReviews?.() ?? []);

  app.get('/api/agents/:id/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wt = hub.reviewWorktree?.(id);
    if (!wt || !hub.git) {
      return reply.code(404).send({ ok: false, error: 'no review for agent' });
    }
    try {
      const files: DiffStat[] = await hub.git.diffStat(wt.worktreePath, wt.mainBranch);
      const patch = capPatch(await hub.git.diffAgainstMain(wt.worktreePath, wt.mainBranch));
      const branch = hub.listReviews?.().find((r) => r.agentId === id)?.branch;
      const diff: AgentDiff = { agentId: id, branch, files, patch };
      return diff;
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/agents/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decision, comments } = (req.body ?? {}) as {
      decision?: 'approve' | 'request-changes';
      comments?: string;
    };
    if (decision === 'approve') {
      if (!hub.approveReview?.(id)) {
        return reply.code(404).send({ ok: false, error: 'no review for agent' });
      }
      return { ok: true };
    }
    if (decision === 'request-changes') {
      const trimmed = comments?.trim();
      if (!trimmed) return reply.code(400).send({ ok: false, error: 'comments required' });
      if (!hub.requestChanges?.(id, trimmed)) {
        return reply.code(404).send({ ok: false, error: 'no review for agent' });
      }
      return { ok: true };
    }
    return reply.code(400).send({ ok: false, error: 'unknown decision' });
  });

  // ---- repo sessions (agents) ----
  app.get('/api/repos/:name/agents', async (req) => {
    if (!hub.store) return [];
    const { name } = req.params as { name: string };
    const costs = hub.store.costSummary().byAgent;
    return hub.store
      .listAgents()
      .filter((a) => a.repo === name)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        model: a.model,
        branch: a.branch,
        worktreePath: a.worktreePath,
        sdkSessionId: a.sdkSessionId,
        taskId: a.taskId,
        taskTitle: hub.store.getTask(a.taskId)?.title ?? '',
        cost: costs[a.id] ?? 0,
      }));
  });

  // Resolve the worktree for an agent, or send the appropriate error reply.
  // Returns undefined after replying when the agent/worktree is missing.
  const resolveWorktree = (
    agentId: string,
    reply: { code(c: number): { send(b: unknown): unknown } },
  ): { worktreePath: string; sdkSessionId?: string } | undefined => {
    const agent = hub.store.getAgent(agentId);
    if (!agent) {
      reply.code(404).send({ ok: false, error: 'agent not found' });
      return undefined;
    }
    if (!agent.worktreePath) {
      reply.code(200).send({ ok: false, error: 'agent has no worktree' });
      return undefined;
    }
    return { worktreePath: agent.worktreePath, sdkSessionId: agent.sdkSessionId };
  };

  // Open the agent's worktree in a terminal running Claude Code (best-effort).
  app.post('/api/sessions/:agentId/open-terminal', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const wt = resolveWorktree(agentId, reply);
    if (!wt) return reply;

    const command = buildResumeCommand(wt.worktreePath, wt.sdkSessionId);
    let opened = false;
    try {
      if (process.platform === 'darwin') {
        // The command is embedded as an AppleScript string literal; escape
        // backslashes first, then double-quotes, so the do script arg is valid.
        const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const tellTerminalScript = `tell application "Terminal" to do script "${escaped}"`;
        await new Promise<void>((resolve, reject) => {
          execFile(
            'osascript',
            ['-e', tellTerminalScript, '-e', 'tell application "Terminal" to activate'],
            (err) => (err ? reject(err) : resolve()),
          );
        });
        opened = true;
      }
      // linux: launching a terminal is unreliable; just return the command.
    } catch {
      opened = false;
    }
    return { ok: true, command, opened };
  });

  // Reveal the agent's worktree folder in the OS file manager (best-effort).
  app.post('/api/sessions/:agentId/reveal', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const wt = resolveWorktree(agentId, reply);
    if (!wt) return reply;

    let opened = false;
    try {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      await new Promise<void>((resolve, reject) => {
        execFile(opener, [wt.worktreePath], (err) => (err ? reject(err) : resolve()));
      });
      opened = true;
    } catch {
      opened = false;
    }
    return { ok: true, opened, path: wt.worktreePath };
  });

  app.post('/api/tasks', async (req, reply) => {
    const body = (req.body ?? {}) as {
      title?: string;
      repo?: string;
      model?: string;
      maxModel?: 'cheap' | 'mid' | 'top' | 'max';
      autonomy?: 'full' | 'standard' | 'careful';
      reviewBeforeMerge?: boolean;
    };
    const title = body.title?.trim();
    if (!title) return reply.code(400).send({ ok: false, error: 'title required' });
    if (!hub.dispatchTask || !hub.config) {
      return reply.code(400).send({ ok: false, error: 'dispatch unavailable' });
    }

    let repo = body.repo;
    if (!repo) {
      const names = Object.keys(hub.config.repos);
      if (names.length === 1) repo = names[0];
      else return reply.code(400).send({ ok: false, error: 'repo required (multiple repos registered)' });
    }

    try {
      const task = await hub.dispatchTask(title, repo, {
        model: body.model,
        maxModel: body.maxModel,
        autonomy: body.autonomy,
        reviewBeforeMerge: body.reviewBeforeMerge,
      });
      return { ok: true, task };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/agents/pause-all', async () => {
    await hub.agents?.pauseAll?.();
    return { ok: true };
  });

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
