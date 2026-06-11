import type { MergeItem } from '../types';

export default function MergeQueueView({ items }: { items: MergeItem[] }) {
  return (
    <div className="panel">
      <h1>Merge queue</h1>
      {items.length === 0 && <div className="empty">queue is empty</div>}
      {items.map((m) => (
        <div className="card" key={m.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{m.branch}</span>
            <span className={`chip ${m.status}`}>{m.status}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'var(--mono)' }}>
            {m.repo} · {new Date(m.submittedAt).toLocaleString()}
          </div>
          {m.gateOutput && (
            <details className="gate">
              <summary>gate output</summary>
              <pre>{m.gateOutput}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
