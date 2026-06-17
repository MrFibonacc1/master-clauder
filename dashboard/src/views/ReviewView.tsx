import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AgentDiff, ReviewInfo } from '../types';

const REFRESH_MS = 5000;
const MAX_DIFF_LINES = 4000;

function timeAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-line hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line';
  if (line.startsWith('+')) return 'diff-line add';
  if (line.startsWith('-')) return 'diff-line del';
  return 'diff-line';
}

function DiffPane({ diff }: { diff: AgentDiff }) {
  const lines = useMemo(() => (diff.patch ? diff.patch.split('\n') : []), [diff.patch]);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const truncated = lines.length - shown.length;

  return (
    <div className="diff-pane">
      <div className="diff-files">
        {diff.files.length === 0 && <div className="empty">no file changes</div>}
        {diff.files.map((f) => (
          <div className="diff-file-row" key={f.file}>
            <span className="diff-file-name">{f.file}</span>
            <span className="diff-file-stat">
              <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
            </span>
          </div>
        ))}
      </div>
      {lines.length === 0 ? (
        <div className="empty">empty patch</div>
      ) : (
        <pre className="diff-body">
          {shown.map((line, i) => (
            <div className={lineClass(line)} key={i}>
              {line || ' '}
            </div>
          ))}
          {truncated > 0 && (
            <div className="diff-line hunk">… {truncated} more lines truncated</div>
          )}
        </pre>
      )}
    </div>
  );
}

export default function ReviewView() {
  const [reviews, setReviews] = useState<ReviewInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<AgentDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .reviews()
        .then((r) => {
          if (!cancelled) setReviews(Array.isArray(r) ? r : []);
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const selected = reviews.find((r) => r.agentId === selectedId) ?? null;

  // Fetch the diff whenever the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    setDiffError(null);
    setDiffLoading(true);
    setComments('');
    setActionError(null);
    api
      .agentDiff(selectedId)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiffError('Could not load diff for this agent.');
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const removeAndClear = (id: string) => {
    setReviews((prev) => prev.filter((r) => r.agentId !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const decide = async (decision: 'approve' | 'request-changes') => {
    if (!selectedId || busy) return;
    if (decision === 'request-changes' && !comments.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.review(
        selectedId,
        decision,
        decision === 'request-changes' ? comments.trim() : undefined,
      );
      if (res && res.ok) {
        removeAndClear(selectedId);
      } else {
        setActionError((res && res.error) || 'Action failed');
      }
    } catch {
      setActionError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-wrap">
      <div className="review-list">
        <h1 className="review-title">Reviews {reviews.length > 0 && <span className="chip needs-review">{reviews.length}</span>}</h1>
        {reviews.length === 0 && (
          <div className="empty">
            No reviews waiting. Run a task with review enabled (--review or the composer's Autonomy/Review
            option) and finished agents will park here.
          </div>
        )}
        {reviews.map((r) => (
          <button
            key={r.agentId}
            className={`review-row${r.agentId === selectedId ? ' active' : ''}`}
            onClick={() => setSelectedId(r.agentId)}
          >
            <div className="review-row-head">
              <span className="review-row-name">{r.agentName}</span>
              <span className="review-row-ago">{timeAgo(r.parkedAt)}</span>
            </div>
            <div className="review-row-task">{r.taskTitle}</div>
            <div className="review-row-meta">
              {r.repo} · {r.branch}
            </div>
          </button>
        ))}
      </div>

      <div className="diff-area">
        {!selected && <div className="empty">Select a review to inspect its diff.</div>}
        {selected && (
          <>
            <div className="diff-head">
              <div>
                <h2 className="diff-head-title">{selected.agentName}</h2>
                <div className="drawer-meta">
                  {selected.repo} · {selected.branch} · {selected.model}
                </div>
                {selected.summary && <div className="review-summary">{selected.summary}</div>}
              </div>
            </div>

            {diffLoading && <div className="empty">loading diff…</div>}
            {diffError && <div className="session-error">{diffError}</div>}
            {diff && <DiffPane diff={diff} />}

            <div className="review-actions">
              <button className="btn primary" disabled={busy} onClick={() => decide('approve')}>
                {busy ? 'Working…' : 'Approve & merge'}
              </button>
              <div className="request-changes">
                <textarea
                  className="review-textarea"
                  placeholder="What should the agent change?"
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={busy || !comments.trim()}
                  onClick={() => decide('request-changes')}
                >
                  Send back
                </button>
              </div>
              {actionError && <div className="session-error">{actionError}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
