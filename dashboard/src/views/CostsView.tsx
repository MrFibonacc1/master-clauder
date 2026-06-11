import type { CortexEvent, StatusSnapshot } from '../types';

export default function CostsView({ status, events }: { status: StatusSnapshot; events: CortexEvent[] }) {
  const ratio = status.budget.perDayUsd > 0 ? Math.min(1, status.daySpendUsd / status.budget.perDayUsd) : 0;
  const taskById = new Map(status.tasks.map((t) => [t.id, t]));
  const agentById = new Map(status.agents.map((a) => [a.id, a]));
  const routed = events.filter((e) => e.type === 'task.routed').slice(-50).reverse();

  return (
    <div className="panel">
      <h1>Costs</h1>

      <div className="budget-bar">
        <div className="labels">
          <span>today: ${status.daySpendUsd.toFixed(4)}</span>
          <span>budget: ${status.budget.perDayUsd.toFixed(2)}/day</span>
        </div>
        <div className="budget-track">
          <div className="budget-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>

      <table className="data">
        <thead>
          <tr><th>Task</th><th>Model</th><th>Status</th><th>Cost</th></tr>
        </thead>
        <tbody>
          {Object.entries(status.costs.byTask).map(([id, cost]) => (
            <tr key={id}>
              <td className="title-cell">{taskById.get(id)?.title ?? id}</td>
              <td>{taskById.get(id)?.model ?? '—'}</td>
              <td><span className={`chip ${taskById.get(id)?.status ?? 'pending'}`}>{taskById.get(id)?.status ?? '?'}</span></td>
              <td className="usd">${cost.toFixed(4)}</td>
            </tr>
          ))}
          {Object.keys(status.costs.byTask).length === 0 && (
            <tr><td colSpan={4} className="empty">no usage recorded yet</td></tr>
          )}
        </tbody>
      </table>

      <table className="data">
        <thead>
          <tr><th>Agent</th><th>Model</th><th>Cost</th></tr>
        </thead>
        <tbody>
          {Object.entries(status.costs.byAgent).map(([id, cost]) => (
            <tr key={id}>
              <td>{agentById.get(id)?.name ?? id}</td>
              <td>{agentById.get(id)?.model ?? '—'}</td>
              <td className="usd">${cost.toFixed(4)}</td>
            </tr>
          ))}
          {Object.keys(status.costs.byAgent).length === 0 && (
            <tr><td colSpan={3} className="empty">no agent usage yet</td></tr>
          )}
        </tbody>
      </table>

      <h1>Routing decisions</h1>
      <table className="data">
        <thead>
          <tr><th>When</th><th>Task</th><th>Model</th><th>Source</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {routed.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.ts).toLocaleTimeString()}</td>
              <td className="title-cell">{taskById.get(e.taskId ?? '')?.title ?? e.taskId}</td>
              <td>{String(e.payload.model ?? '')}</td>
              <td>{String(e.payload.source ?? '')}</td>
              <td className="title-cell">{String(e.payload.reason ?? '')}</td>
            </tr>
          ))}
          {routed.length === 0 && <tr><td colSpan={5} className="empty">no routing decisions yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
