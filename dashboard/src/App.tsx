import { useEffect, useRef, useState } from 'react';
import { api, openEventStream } from './api';
import type { CortexEvent, StatusSnapshot } from './types';
import BrainView from './views/BrainView';
import FarmView from './views/FarmView';
import TaskBoard from './views/TaskBoard';
import MergeQueueView from './views/MergeQueueView';
import ReviewView from './views/ReviewView';
import CostsView from './views/CostsView';
import MemoryView from './views/MemoryView';

const TABS = ['Brain', 'Farm', 'Tasks', 'Merge Queue', 'Review', 'Costs', 'Memory'] as const;
type Tab = (typeof TABS)[number];

const TAB_KEY = 'cortex.tab';
function initialTab(): Tab {
  const saved = localStorage.getItem(TAB_KEY);
  if (saved && (TABS as readonly string[]).includes(saved)) return saved as Tab;
  return 'Farm'; // first-ever load shows the farm scene
}

const EMPTY: StatusSnapshot = {
  tasks: [],
  agents: [],
  costs: { byTask: {}, byAgent: {}, total: 0 },
  daySpendUsd: 0,
  budget: { perTaskUsd: 5, perDayUsd: 25, warnRatio: 0.8 },
  mergeQueue: [],
};

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [status, setStatus] = useState<StatusSnapshot>(EMPTY);
  const [events, setEvents] = useState<CortexEvent[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  useEffect(() => {
    const load = () =>
      api
        .reviews()
        .then((r) => setReviewCount(Array.isArray(r) ? r.length : 0))
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);

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
              {t === 'Review' && reviewCount > 0 ? `Review (${reviewCount})` : t}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <button className="btn topbar-btn" onClick={() => setComposerOpen(true)}>+ New task</button>
          <button className="btn topbar-btn" onClick={() => api.pauseAll().catch(() => {})}>Pause all</button>
        </div>
        <span className="spend">
          today <b>${status.daySpendUsd.toFixed(2)}</b> / ${status.budget.perDayUsd} ({Math.round(ratio * 100)}%)
        </span>
      </header>
      <main className="view">
        {tab === 'Brain' && <BrainView status={status} events={events} />}
        {tab === 'Farm' && <FarmView status={status} events={events} />}
        {tab === 'Tasks' && <TaskBoard status={status} />}
        {tab === 'Merge Queue' && <MergeQueueView items={status.mergeQueue} />}
        {tab === 'Review' && <ReviewView />}
        {tab === 'Costs' && <CostsView status={status} events={events} />}
        {tab === 'Memory' && <MemoryView />}
      </main>
      {composerOpen && <TaskComposer onClose={() => setComposerOpen(false)} />}
    </div>
  );
}

const MODEL_OPTIONS: { label: string; value: string }[] = [
  { label: 'Auto (router picks best)', value: '' },
  { label: 'Haiku', value: 'claude-haiku-4-5' },
  { label: 'Sonnet', value: 'claude-sonnet-4-6' },
  { label: 'Opus', value: 'claude-opus-4-8' },
  { label: 'Fable', value: 'claude-fable-5' },
];
const MAX_MODEL_OPTIONS = ['', 'cheap', 'mid', 'top', 'max'] as const;
const AUTONOMY_OPTIONS: { label: string; value: string }[] = [
  { label: 'Standard — auto-grant safe, gate the dangerous', value: '' },
  { label: 'Full (--yolo) — never ask, allow everything', value: 'full' },
  { label: 'Careful — read & plan, gate edits', value: 'careful' },
];

function TaskComposer({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [repo, setRepo] = useState('');
  const [model, setModel] = useState('');
  const [maxModel, setMaxModel] = useState('');
  const [autonomy, setAutonomy] = useState('');
  const [reviewBeforeMerge, setReviewBeforeMerge] = useState(false);
  const [repos, setRepos] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .repos()
      .then((r) => {
        setRepos(r);
        if (r.length >= 1) setRepo(r[0].name);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const singleRepo = repos.length === 1;

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const body: {
      title: string;
      repo?: string;
      model?: string;
      maxModel?: string;
      autonomy?: string;
      reviewBeforeMerge?: boolean;
    } = { title: title.trim() };
    if (repo) body.repo = repo;
    if (model) body.model = model;
    if (maxModel) body.maxModel = maxModel;
    if (autonomy) body.autonomy = autonomy;
    if (reviewBeforeMerge) body.reviewBeforeMerge = true;
    try {
      const res = await api.createTask(body);
      if (res && res.ok) {
        onClose();
      } else {
        setError((res && res.error) || 'Failed to create task');
      }
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}>✕</button>
        <h2 className="modal-title">New task</h2>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span>Title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What should the agent do?"
              required
            />
          </label>
          {!singleRepo && (
            <label className="field">
              <span>Repo</span>
              <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.label} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Max model cap</span>
            <select value={maxModel} onChange={(e) => setMaxModel(e.target.value)}>
              {MAX_MODEL_OPTIONS.map((m) => (
                <option key={m || 'none'} value={m}>
                  {m === '' ? 'none' : m}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Autonomy</span>
            <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
              {AUTONOMY_OPTIONS.map((a) => (
                <option key={a.value || 'standard'} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-check">
            <input type="checkbox" checked={reviewBeforeMerge} onChange={(e) => setReviewBeforeMerge(e.target.checked)} />
            <span>Review before merge — park the diff for my approval instead of auto-merging</span>
          </label>
          {error && <div className="composer-error">{error}</div>}
          <div className="composer-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!title.trim() || submitting}>
              {submitting ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
