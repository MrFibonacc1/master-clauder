import { useEffect, useRef, useState } from 'react';
import { api, openEventStream } from './api';
import type { CortexEvent, StatusSnapshot } from './types';
import BrainView from './views/BrainView';
import TaskBoard from './views/TaskBoard';
import MergeQueueView from './views/MergeQueueView';
import CostsView from './views/CostsView';
import MemoryView from './views/MemoryView';

const TABS = ['Brain', 'Tasks', 'Merge Queue', 'Costs', 'Memory'] as const;
type Tab = (typeof TABS)[number];

const EMPTY: StatusSnapshot = {
  tasks: [],
  agents: [],
  costs: { byTask: {}, byAgent: {}, total: 0 },
  daySpendUsd: 0,
  budget: { perTaskUsd: 5, perDayUsd: 25, warnRatio: 0.8 },
  mergeQueue: [],
};

export default function App() {
  const [tab, setTab] = useState<Tab>('Brain');
  const [status, setStatus] = useState<StatusSnapshot>(EMPTY);
  const [events, setEvents] = useState<CortexEvent[]>([]);
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    api.events(0).then(setEvents).catch(() => {});
    const refresh = () => api.status().then(setStatus).catch(() => {});
    const close = openEventStream(
      (s) => setStatus((prev) => ({ ...prev, ...s })),
      (e) => {
        setEvents((prev) => (prev.length > 3000 ? [...prev.slice(-2000), e] : [...prev, e]));
        // debounce a status refresh after bursts of events
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(refresh, 400);
      },
    );
    refresh();
    return close;
  }, []);

  const ratio = status.budget.perDayUsd > 0 ? status.daySpendUsd / status.budget.perDayUsd : 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">◉ Cortex</span>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={`tab${t === tab ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <span className="spend">
          today <b>${status.daySpendUsd.toFixed(2)}</b> / ${status.budget.perDayUsd} ({Math.round(ratio * 100)}%)
        </span>
      </header>
      <main className="view">
        {tab === 'Brain' && <BrainView status={status} events={events} />}
        {tab === 'Tasks' && <TaskBoard status={status} />}
        {tab === 'Merge Queue' && <MergeQueueView items={status.mergeQueue} />}
        {tab === 'Costs' && <CostsView status={status} events={events} />}
        {tab === 'Memory' && <MemoryView />}
      </main>
    </div>
  );
}
