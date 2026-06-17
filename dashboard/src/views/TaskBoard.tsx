import type { StatusSnapshot, TaskStatus } from '../types';

const COLUMNS: TaskStatus[] = ['pending', 'planning', 'running', 'blocked', 'needs-review', 'awaiting-merge', 'done', 'failed'];

export default function TaskBoard({ status }: { status: StatusSnapshot }) {
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const tasks = status.tasks.filter((t) => t.status === col || (col === 'failed' && t.status === 'killed'));
        return (
          <div className="col" key={col}>
            <h3>
              {col} <span>{tasks.length}</span>
            </h3>
            {tasks.map((t) => (
              <div className="card task-card" key={t.id}>
                <div className="title">{t.title}</div>
                <div className="meta">
                  <span>{t.model}</span>
                  <span className="usd">${(status.costs.byTask[t.id] ?? 0).toFixed(3)}</span>
                </div>
                <div className="meta" style={{ marginTop: 4 }}>
                  <span>{t.repo}</span>
                  <span className={`chip ${t.status}`}>{t.status}</span>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
