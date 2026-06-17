import { useEffect, useRef } from 'react';
import type { AgentRecord, CortexEvent, StatusSnapshot } from '../types';

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
  const transcript = events.filter(
    (e) => e.agentId === agent.id && ['agent.message', 'agent.tool', 'agent.memory'].includes(e.type),
  );
  const cost = status.costs.byAgent[agent.id] ?? 0;
  const cap = status.budget.perTaskUsd || 1;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [transcript.length]);

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
    </aside>
  );
}
