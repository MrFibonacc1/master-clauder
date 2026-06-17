import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RepoAgent } from '../types';

type ActionState = { kind: 'idle' } | { kind: 'opened' } | { kind: 'command'; command: string } | { kind: 'error'; message: string };

function SessionRow({ agent }: { agent: RepoAgent }) {
  const [open, setOpen] = useState<ActionState>({ kind: 'idle' });
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const openLabel = agent.sdkSessionId ? 'Open in Claude Code' : 'Open worktree';

  const onOpen = async () => {
    try {
      const r = await api.openTerminal(agent.id);
      if (r && r.ok && r.opened) {
        setOpen({ kind: 'opened' });
        setTimeout(() => setOpen({ kind: 'idle' }), 2000);
      } else if (r && r.ok) {
        setOpen({ kind: 'command', command: String(r.command ?? '') });
      } else {
        setOpen({ kind: 'error', message: String(r?.error ?? 'failed') });
      }
    } catch (e) {
      setOpen({ kind: 'error', message: e instanceof Error ? e.message : 'failed' });
    }
  };

  const onReveal = async () => {
    try {
      await api.reveal(agent.id);
      setRevealed(true);
      setTimeout(() => setRevealed(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const onCopy = (command: string) => {
    navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="session-row">
      <div className="session-head">
        <span className="session-name">{agent.name}</span>
        <span className={`chip ${agent.status}`}>{agent.status}</span>
      </div>
      <div className="session-meta">
        {agent.model}
        <span className="session-branch">{agent.branch ?? '—'}</span>
        <span className="session-cost">${agent.cost.toFixed(4)}</span>
      </div>
      <div className="session-actions">
        <button className="btn" onClick={onOpen}>
          {open.kind === 'opened' ? 'opened ✓' : openLabel}
        </button>
        <button className="btn" onClick={onReveal}>
          {revealed ? 'revealed ✓' : 'Reveal'}
        </button>
      </div>
      {open.kind === 'command' && (
        <div className="cmd-box">
          <code>{open.command}</code>
          <button className="btn" onClick={() => onCopy(open.command)}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      )}
      {open.kind === 'error' && <div className="session-error">{open.message}</div>}
    </div>
  );
}

export default function RepoDrawer({ repo, onClose }: { repo: string; onClose: () => void }) {
  const [agents, setAgents] = useState<RepoAgent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAgents(null);
    api
      .repoAgents(repo)
      .then((r) => {
        if (!cancelled) setAgents(Array.isArray(r) ? r : []);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const count = agents?.length ?? 0;

  return (
    <aside className="drawer">
      <button className="drawer-close" onClick={onClose}>✕</button>
      <div className="drawer-head">
        <h2>{repo}</h2>
        <div className="drawer-meta">{count} session{count === 1 ? '' : 's'}</div>
      </div>
      <div className="session-list">
        {agents === null && <div className="empty">loading…</div>}
        {agents !== null && agents.length === 0 && <div className="empty">no sessions yet on this repo</div>}
        {agents?.map((a) => (
          <SessionRow key={a.id} agent={a} />
        ))}
      </div>
    </aside>
  );
}
