import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { AgentRecord, BrainNote, CortexEvent, StatusSnapshot } from '../types';
import AgentDrawer from './AgentDrawer';

type NodeKind = 'agent' | 'repo' | 'task' | 'note';

interface SimNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ref?: AgentRecord;
  seeded?: boolean;
}

interface SimLink {
  a: number; // node index
  b: number;
  len: number;
}

const COLORS: Record<string, string> = {
  repo: '#8b7cf6',
  task: '#5c6480',
  note: '#3a3f55',
  working: '#4dd6ff',
  starting: '#4dd6ff',
  blocked: '#f87171',
  paused: '#fbbf24',
  done: '#4ade80',
  failed: '#f87171',
  killed: '#5c6480',
};

function agentColor(a?: AgentRecord): string {
  return COLORS[a?.status ?? 'working'] ?? '#4dd6ff';
}

export default function BrainView({ status, events }: { status: StatusSnapshot; events: CortexEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [notes, setNotes] = useState<BrainNote[]>([]);
  const [selected, setSelected] = useState<AgentRecord | null>(null);
  // Persist node positions/velocities across rebuilds so the layout doesn't snap
  // back to the spiral every time a status refresh produces new array references.
  const posRef = useRef<Map<string, SimNode>>(new Map());

  useEffect(() => {
    api
      .memoryList()
      .then((r) => setNotes(Array.isArray(r) ? (r as BrainNote[]) : []))
      .catch(() => {});
  }, []);

  // Build graph data (stable ids so the sim can preserve positions).
  const graph = useMemo(() => {
    const nodes: SimNode[] = [];
    const index = new Map<string, number>();
    const add = (id: string, kind: NodeKind, label: string, r: number, ref?: AgentRecord) => {
      if (index.has(id)) return index.get(id)!;
      index.set(id, nodes.length);
      // Reuse the persisted node (keeps x/y/vx/vy) if we've seen this id before;
      // only brand-new ids get a fresh, unseeded node placed by the physics effect.
      const existing = posRef.current.get(id);
      let node: SimNode;
      if (existing) {
        existing.kind = kind;
        existing.label = label;
        existing.r = r;
        existing.ref = ref;
        node = existing;
      } else {
        node = { id, kind, label, x: 0, y: 0, vx: 0, vy: 0, r, ref, seeded: false };
        posRef.current.set(id, node);
      }
      nodes.push(node);
      return nodes.length - 1;
    };
    const links: SimLink[] = [];
    const repos = new Set<string>([
      ...status.tasks.map((t) => t.repo),
      ...status.agents.map((a) => a.repo),
      ...notes.map((n) => n.repo).filter((r): r is string => !!r),
    ]);
    for (const r of repos) add(`repo:${r}`, 'repo', r, 22);
    for (const t of status.tasks.slice(0, 60)) {
      const ti = add(`task:${t.id}`, 'task', t.title.slice(0, 28), 7);
      if (index.has(`repo:${t.repo}`)) links.push({ a: ti, b: index.get(`repo:${t.repo}`)!, len: 110 });
    }
    for (const a of status.agents) {
      const ai = add(`agent:${a.id}`, 'agent', a.name, 13, a);
      if (index.has(`repo:${a.repo}`)) links.push({ a: ai, b: index.get(`repo:${a.repo}`)!, len: 90 });
      if (index.has(`task:${a.taskId}`)) links.push({ a: ai, b: index.get(`task:${a.taskId}`)!, len: 60 });
    }
    for (const n of notes.slice(0, 150)) {
      const ni = add(`note:${n.relPath}`, 'note', n.title.slice(0, 22), 4);
      if (n.repo && index.has(`repo:${n.repo}`)) links.push({ a: ni, b: index.get(`repo:${n.repo}`)!, len: 140 });
      for (const l of n.links) {
        const target = [...index.keys()].find((k) => k.startsWith('note:') && k.includes(l));
        if (target) links.push({ a: ni, b: index.get(target)!, len: 80 });
      }
    }
    // GC persisted nodes whose ids are no longer present.
    for (const id of [...posRef.current.keys()]) {
      if (!index.has(id)) posRef.current.delete(id);
    }
    return { nodes, links };
  }, [status.tasks, status.agents, notes]);

  // Physics + rendering loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let dead = false;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;

    // seed positions deterministically around center — only for new (unseeded)
    // nodes, so existing nodes keep their settled positions across rebuilds.
    graph.nodes.forEach((n, i) => {
      if (n.seeded) return;
      const angle = (i * 2.399963) % (Math.PI * 2); // golden angle spiral
      const rad = 40 + 16 * Math.sqrt(i);
      n.x = W() / 2 + rad * Math.cos(angle);
      n.y = H() / 2 + rad * Math.sin(angle);
      n.seeded = true;
    });

    let hover: SimNode | null = null;

    const step = () => {
      const nodes = graph.nodes;
      // repulsion (n² fine for our scale)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          const f = 1400 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      // springs
      for (const l of graph.links) {
        const a = graph.nodes[l.a];
        const b = graph.nodes[l.b];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - l.len) * 0.012;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      // gentle centering + damping + integrate
      const cx = W() / 2;
      const cy = H() / 2;
      for (const n of graph.nodes) {
        n.vx += (cx - n.x) * 0.0012;
        n.vy += (cy - n.y) * 0.0012;
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += n.vx;
        n.y += n.vy;
      }
    };

    const draw = (t: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0d0e14';
      ctx.fillRect(0, 0, W(), H());

      // edges
      ctx.lineWidth = 1;
      for (const l of graph.links) {
        const a = graph.nodes[l.a];
        const b = graph.nodes[l.b];
        ctx.strokeStyle = 'rgba(120, 130, 170, 0.14)';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // nodes
      for (const n of graph.nodes) {
        let color: string;
        let r = n.r;
        if (n.kind === 'agent') {
          color = agentColor(n.ref);
          if (n.ref?.status === 'working' || n.ref?.status === 'starting') {
            r = n.r + 2.5 * Math.sin(t / 280 + n.x); // pulse
          }
        } else {
          color = COLORS[n.kind];
        }

        // glow
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2);
        grad.addColorStop(0, color + 'aa');
        grad.addColorStop(1, color + '00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();

        // core
        ctx.shadowColor = color;
        ctx.shadowBlur = n.kind === 'note' ? 4 : 14;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // blocked ring
        if (n.kind === 'agent' && n.ref?.status === 'blocked') {
          ctx.strokeStyle = '#f87171';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
        }

        // labels for big / hovered nodes
        if (n.kind === 'repo' || n.kind === 'agent' || n === hover) {
          ctx.fillStyle = n === hover ? '#dfe4f5' : 'rgba(180, 188, 215, 0.75)';
          ctx.font = `${n.kind === 'repo' ? 13 : 11}px ${getComputedStyle(document.body).fontFamily}`;
          ctx.textAlign = 'center';
          ctx.fillText(n.label, n.x, n.y + r + 16);
        }
      }
    };

    const loop = (t: number) => {
      if (dead) return;
      step();
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const pick = (mx: number, my: number): SimNode | null => {
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of graph.nodes) {
        const d = Math.hypot(n.x - mx, n.y - my);
        if (d < Math.max(14, n.r + 6) && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      hover = pick(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = hover ? 'pointer' : 'grab';
    };
    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const n = pick(e.clientX - rect.left, e.clientY - rect.top);
      setSelected(n?.kind === 'agent' && n.ref ? n.ref : null);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('click', onClick);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
    };
  }, [graph]);

  return (
    <div className="brain-wrap">
      <canvas ref={canvasRef} className="brain-canvas" />
      <div className="legend">
        <span><span className="dot" style={{ background: '#4dd6ff' }} />agent (working)</span>
        <span><span className="dot" style={{ background: '#f87171' }} />agent (blocked)</span>
        <span><span className="dot" style={{ background: '#fbbf24' }} />agent (paused)</span>
        <span><span className="dot" style={{ background: '#4ade80' }} />agent (done)</span>
        <span><span className="dot" style={{ background: '#8b7cf6' }} />repo</span>
        <span><span className="dot" style={{ background: '#5c6480' }} />task</span>
        <span><span className="dot" style={{ background: '#3a3f55' }} />memory note</span>
      </div>
      {selected && <AgentDrawer agent={selected} events={events} status={status} onClose={() => setSelected(null)} />}
    </div>
  );
}
