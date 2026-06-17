import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AgentRecord, CortexEvent, StatusSnapshot } from '../types';

type DrawerTab = 'transcript' | 'log';

const LOG_POLL_MS = 1500;

/** Render a single raw log line (a JSON-encoded AgentToHubMsg) as a compact one-liner. */
function formatLogLine(raw: string): string {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return raw;
  }
  switch (msg.kind) {
    case 'message':
      return String(msg.text ?? '');
    case 'tool':
      return `⚙ ${String(msg.name ?? 'tool')}: ${String(msg.summary ?? '')}`;
    case 'usage': {
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      const cost = typeof usage.costUsd === 'number' ? usage.costUsd : 0;
      return `$${cost.toFixed(4)}`;
    }
    case 'done':
      return `${msg.success ? '✓' : '✗'} ${String(msg.summary ?? '')}`;
    case 'status':
      return `• ${String(msg.status ?? '')}${msg.detail ? ` — ${String(msg.detail)}` : ''}`;
    case 'memory':
      return `◈ memory ${String(msg.op ?? '')}: ${String(msg.relPath ?? '')}`;
    case 'session':
      return `↪ session ${String(msg.sdkSessionId ?? '')}`;
    case 'approval':
      return `⏸ approval ${String(msg.action ?? '')}`;
    default:
      return raw;
  }
}

function LogTab({ agentId }: { agentId: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setError(false);
    const load = () =>
      api
        .agentLog(agentId)
        .then((r) => {
          if (cancelled) return;
          setLines(Array.isArray(r?.lines) ? r.lines : []);
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    load();
    const timer = window.setInterval(load, LOG_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <pre className="transcript log-pre">
      {lines === null && <div className="empty">loading log…</div>}
      {error && lines === null && <div className="session-error">could not load log</div>}
      {lines !== null && lines.length === 0 && <div className="empty">log is empty</div>}
      {lines?.map((line, i) => (
        <div className="log-line" key={i}>
          {formatLogLine(line)}
        </div>
      ))}
      <div ref={endRef} />
    </pre>
  );
}

export default function AgentDrawer({
  agent,
  events,
  status,
  onClose,
}: {
  agent: AgentRecord;
  events: CortexEvent[];
  status: StatusSnapshot;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('transcript');
  const transcript = events.filter(
    (e) => e.agentId === agent.id && ['agent.message', 'agent.tool', 'agent.memory'].includes(e.type),
  );
  const cost = status.costs.byAgent[agent.id] ?? 0;
  const cap = status.budget.perTaskUsd || 1;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [transcript.length]);

  // reset to transcript when switching agents
  useEffect(() => setTab('transcript'), [agent.id]);

  return (
    <aside className="drawer">
      <button className="drawer-close" onClick={onClose}>✕</button>
      <div className="drawer-head">
        <h2>{agent.name} <span className={`chip ${agent.status}`}>{agent.status}</span></h2>
        <div className="drawer-meta">
          model {agent.model}<br />
          branch {agent.branch ?? '—'}<br />
          task {agent.taskId}
        </div>
        <div className="cost-meter">
          <div className="drawer-meta">${cost.toFixed(4)} / ${cap.toFixed(2)} task budget</div>
          <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.min(100, (cost / cap) * 100)}%` }} /></div>
        </div>
      </div>
      <div className="drawer-tabs">
        <button className={`drawer-tab${tab === 'transcript' ? ' active' : ''}`} onClick={() => setTab('transcript')}>
          Transcript
        </button>
        <button className={`drawer-tab${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>
          Log
        </button>
      </div>
      {tab === 'transcript' ? (
        <div className="transcript">
          {transcript.length === 0 && <div className="empty">no transcript yet</div>}
          {transcript.map((e) => (
            <div key={e.id} className={`tr-line ${e.type === 'agent.tool' ? 'tool' : e.type === 'agent.memory' ? 'memory' : ''}`}>
              <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
              {e.type === 'agent.message' && String(e.payload.text ?? '')}
              {e.type === 'agent.tool' && `⚙ ${e.payload.name}: ${String(e.payload.summary ?? '')}`}
              {e.type === 'agent.memory' && `◈ memory ${e.payload.op}: ${e.payload.relPath}`}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : (
        <LogTab agentId={agent.id} />
      )}
    </aside>
  );
}
