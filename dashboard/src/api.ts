import type { AgentDiff, AgentRecord, CortexEvent, CostSummary, MemoryHit, MergeItem, RepoAgent, ReviewInfo, StatusSnapshot, TaskRecord } from './types';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => get<StatusSnapshot>('/api/status'),
  tasks: () => get<TaskRecord[]>('/api/tasks'),
  agents: () => get<AgentRecord[]>('/api/agents'),
  events: (since = 0) => get<CortexEvent[]>(`/api/events?since=${since}`),
  costs: () => get<CostSummary>('/api/costs'),
  mergeQueue: () => get<MergeItem[]>('/api/merge-queue'),
  memorySearch: (q: string) => get<MemoryHit[]>(`/api/memory?q=${encodeURIComponent(q)}`),
  memoryList: () => get<unknown>('/api/memory'),
  pin: (relPath: string, pinned: boolean) =>
    fetch('/api/memory/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relPath, pinned }),
    }),
  deleteNote: (relPath: string) =>
    fetch('/api/memory', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relPath }),
    }),
  agentAction: (id: string, action: 'pause' | 'resume' | 'kill') =>
    fetch(`/api/agents/${id}/${action}`, { method: 'POST' }),
  repos: () => get<{ name: string; path: string }[]>('/api/repos'),
  repoAgents: (name: string) => get<RepoAgent[]>('/api/repos/' + encodeURIComponent(name) + '/agents'),
  openTerminal: (agentId: string) =>
    fetch('/api/sessions/' + encodeURIComponent(agentId) + '/open-terminal', { method: 'POST' }).then((r) => r.json()),
  reveal: (agentId: string) =>
    fetch('/api/sessions/' + encodeURIComponent(agentId) + '/reveal', { method: 'POST' }).then((r) => r.json()),
  createTask: (body: {
    title: string;
    repo?: string;
    model?: string;
    maxModel?: string;
    autonomy?: string;
    reviewBeforeMerge?: boolean;
  }) =>
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  pauseAll: () => fetch('/api/agents/pause-all', { method: 'POST' }),
  reviews: () => get<ReviewInfo[]>('/api/reviews'),
  agentDiff: (id: string) => get<AgentDiff>('/api/agents/' + encodeURIComponent(id) + '/diff'),
  agentLog: (id: string, tail = 800) =>
    get<{ ok: boolean; lines: string[] }>('/api/agents/' + encodeURIComponent(id) + '/log?tail=' + tail),
  claudeMd: (repo: string) =>
    get<{ ok: boolean; content: string; exists: boolean; path: string }>(
      '/api/repos/' + encodeURIComponent(repo) + '/claude-md',
    ),
  saveClaudeMd: (repo: string, content: string) =>
    fetch('/api/repos/' + encodeURIComponent(repo) + '/claude-md', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then((r) => r.json()),
  review: (id: string, decision: 'approve' | 'request-changes', comments?: string) =>
    fetch('/api/agents/' + encodeURIComponent(id) + '/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, comments }),
    }).then((r) => r.json()),
};

export function openEventStream(onSnapshot: (s: StatusSnapshot) => void, onEvent: (e: CortexEvent) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws: WebSocket | null = null;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string);
      if (msg.type === 'snapshot') onSnapshot(msg.status);
      else if (msg.type === 'event') onEvent(msg.event);
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
