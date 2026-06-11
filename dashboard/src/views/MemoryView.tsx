import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BrainNote, MemoryHit } from '../types';

export default function MemoryView() {
  const [q, setQ] = useState('');
  const [notes, setNotes] = useState<BrainNote[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});

  const load = async (query: string) => {
    if (query.trim()) {
      const hits = (await api.memorySearch(query)) as MemoryHit[];
      setNotes(hits.map((h) => h.note));
      setScores(Object.fromEntries(hits.map((h) => [h.note.relPath, h.score])));
    } else {
      const all = await api.memoryList();
      setNotes(Array.isArray(all) ? (all as BrainNote[]) : []);
      setScores({});
    }
  };

  useEffect(() => {
    load('').catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);

  const togglePin = async (n: BrainNote) => {
    await api.pin(n.relPath, !n.pinned);
    setNotes((prev) => prev.map((x) => (x.relPath === n.relPath ? { ...x, pinned: !n.pinned } : x)));
  };

  const remove = async (n: BrainNote) => {
    if (!confirm(`Delete note "${n.title}"? This removes the file from the vault.`)) return;
    await api.deleteNote(n.relPath);
    setNotes((prev) => prev.filter((x) => x.relPath !== n.relPath));
  };

  return (
    <div className="panel">
      <h1>Memory</h1>
      <div className="search-row">
        <input placeholder="search the brain…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      {notes.length === 0 && <div className="empty">no notes</div>}
      {notes.map((n) => (
        <div className="card note-card" key={n.relPath}>
          <div className="body">
            <div className="title">
              {n.pinned ? '📌 ' : ''}{n.title}
              {scores[n.relPath] !== undefined && (
                <span style={{ color: 'var(--accent)', fontSize: 11, marginLeft: 8, fontFamily: 'var(--mono)' }}>
                  {scores[n.relPath].toFixed(3)}
                </span>
              )}
            </div>
            <div className="path">{n.relPath}</div>
            <div>
              {n.tags.map((t) => (
                <span className="tag" key={t}>{t}</span>
              ))}
              <span className="tag" style={{ background: 'rgba(77,214,255,0.1)', color: 'var(--accent)' }}>{n.type}</span>
            </div>
            <div className="excerpt">{n.body.slice(0, 200)}</div>
          </div>
          <div className="note-actions">
            <button className={`btn${n.pinned ? ' pinned' : ''}`} onClick={() => togglePin(n)}>
              {n.pinned ? 'unpin' : 'pin'}
            </button>
            <button className="btn danger" onClick={() => remove(n)}>delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
