import { useEffect, useRef, useState } from 'react';
import type { AgentRecord, CortexEvent, StatusSnapshot } from '../types';
import AgentDrawer from './AgentDrawer';
import RepoDrawer from './RepoDrawer';

// 2D "farm" view: the canvas is partitioned into one big region per repo
// (2 repos → left/right halves, 3 → thirds, 4 → 2×2, …). Every agent on a
// repo is a little worker tending that repo's field; status reads from pose.

const C = {
  bg: '#0d0e14',
  fieldA: '#1d2c1a',
  fieldB: '#22331d',
  furrow: '#172310',
  sign: '#6b4a2f',
  signEdge: '#4a3220',
  fence: '#3a3f55',
  text: '#c9cede',
  muted: '#8a90a6',
  dim: '#6b7188',
  skin: '#caa472',
  hat: '#b8954f',
  crop: '#6fa83a',
  wheat: '#e8c24a',
  accent: '#4dd6ff',
  violet: '#8b7cf6',
  green: '#4ade80',
  amber: '#fbbf24',
  red: '#f87171',
  failMuted: '#a85a5a',
};

function modelColor(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return C.violet;
  if (m.includes('sonnet')) return C.accent;
  if (m.includes('haiku')) return C.green;
  return C.dim;
}

const STATUS_COLOR: Record<string, string> = {
  starting: C.amber,
  working: C.accent,
  blocked: C.red,
  paused: C.amber,
  done: C.green,
  failed: C.red,
  killed: C.dim,
};

/** Stable per-id phase so workers don't animate in lockstep. */
function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 1000) / 1000) * Math.PI * 2;
}

interface Chip {
  text: string;
  born: number;
  kind: 'tool' | 'message';
}
interface WState {
  phase: number;
  chips: Chip[];
}

interface WorkerBox {
  agent: AgentRecord;
  x: number;
  y: number;
  size: number;
}
interface Region {
  repo: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cost: number;
  workers: WorkerBox[];
}

const HEADER_H = 30;

/** Distribute n repos into evenly-sized regions tiling the whole canvas. */
function computeLayout(
  W: number,
  H: number,
  repos: string[],
  agentsByRepo: Map<string, AgentRecord[]>,
  costByRepo: Map<string, number>,
): Region[] {
  const n = repos.length;
  if (n === 0) return [];
  let rows: number;
  if (n <= 3) rows = 1;
  else if (n === 4) rows = 2;
  else rows = Math.ceil(n / Math.ceil(Math.sqrt(n)));
  const base = Math.floor(n / rows);
  const extra = n % rows;

  const gap = 6;
  const regions: Region[] = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const count = base + (r < extra ? 1 : 0);
    const rh = H / rows;
    const rw = W / count;
    for (let c = 0; c < count; c++) {
      const repo = repos[idx++];
      const x = c * rw + gap;
      const y = r * rh + gap;
      const w = rw - 2 * gap;
      const h = rh - 2 * gap;

      // lay this repo's agents in an aspect-aware grid inside the field body
      const ags = agentsByRepo.get(repo) ?? [];
      const m = ags.length;
      const bodyX = x + 12;
      const bodyY = y + HEADER_H + 10;
      const bodyW = w - 24;
      const bodyH = h - HEADER_H - 22;
      const workers: WorkerBox[] = [];
      if (m > 0) {
        const wc = Math.max(1, Math.round(Math.sqrt((m * bodyW) / Math.max(bodyH, 1))));
        const cols = Math.min(m, wc);
        const wr = Math.ceil(m / cols);
        const cellW = bodyW / cols;
        const cellH = bodyH / wr;
        const size = Math.max(16, Math.min(34, Math.min(cellW, cellH) * 0.42));
        ags.forEach((agent, k) => {
          const col = k % cols;
          const row = Math.floor(k / cols);
          workers.push({
            agent,
            x: bodyX + cellW * (col + 0.5),
            y: bodyY + cellH * (row + 0.5),
            size,
          });
        });
      }
      regions.push({ repo, x, y, w, h, cost: costByRepo.get(repo) ?? 0, workers });
    }
  }
  return regions;
}

export default function FarmView({ status, events }: { status: StatusSnapshot; events: CortexEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<AgentRecord | null>(null);
  const [repoSel, setRepoSel] = useState<string | null>(null);

  const wsRef = useRef<Map<string, WState>>(new Map());
  CHIPS = wsRef.current; // expose the live per-agent state to the module draw helpers
  const lastEventIdRef = useRef<number>(0);
  const layoutRef = useRef<Region[]>([]);
  const statusRef = useRef(status);
  statusRef.current = status;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let dead = false;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    window.addEventListener('resize', resize);
    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;

    const consumeEvents = (now: number) => {
      let maxId = lastEventIdRef.current;
      for (const e of eventsRef.current) {
        if (e.id <= lastEventIdRef.current) continue;
        maxId = Math.max(maxId, e.id);
        if (!e.agentId) continue;
        if (e.type !== 'agent.tool' && e.type !== 'agent.message') continue;
        const st = wsRef.current.get(e.agentId);
        if (!st) continue;
        const text =
          e.type === 'agent.tool'
            ? String((e.payload as Record<string, unknown>).name ?? 'tool')
            : String((e.payload as Record<string, unknown>).text ?? '').slice(0, 22);
        st.chips.push({ text, born: now, kind: e.type === 'agent.tool' ? 'tool' : 'message' });
        if (st.chips.length > 3) st.chips.shift();
      }
      lastEventIdRef.current = maxId;
    };

    const draw = (t: number) => {
      const s = statusRef.current;
      // repos present (from agents + tasks), sorted for stable placement
      const repoSet = new Set<string>([
        ...s.agents.map((a) => a.repo).filter(Boolean),
        ...s.tasks.map((tk) => tk.repo).filter(Boolean),
      ]);
      const repos = [...repoSet].sort();
      const agentsByRepo = new Map<string, AgentRecord[]>();
      for (const a of s.agents) {
        if (!agentsByRepo.has(a.repo)) agentsByRepo.set(a.repo, []);
        agentsByRepo.get(a.repo)!.push(a);
      }
      const costByRepo = new Map<string, number>();
      for (const a of s.agents) {
        costByRepo.set(a.repo, (costByRepo.get(a.repo) ?? 0) + (s.costs.byAgent[a.id] ?? 0));
      }
      // ensure per-agent anim state exists; GC departed agents
      const liveIds = new Set(s.agents.map((a) => a.id));
      for (const a of s.agents) {
        if (!wsRef.current.has(a.id)) wsRef.current.set(a.id, { phase: hashPhase(a.id), chips: [] });
      }
      for (const id of [...wsRef.current.keys()]) if (!liveIds.has(id)) wsRef.current.delete(id);

      consumeEvents(t);

      const regions = computeLayout(W(), H(), repos, agentsByRepo, costByRepo);
      layoutRef.current = regions;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, W(), H());

      if (regions.length === 0) {
        ctx.fillStyle = C.dim;
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('no agents running yet — dispatch a task to populate the farm', W() / 2, H() / 2);
        raf = dead ? 0 : requestAnimationFrame(draw);
        return;
      }

      for (const reg of regions) drawRegion(ctx, reg, t);
      for (const reg of regions) for (const wb of reg.workers) drawWorker(ctx, wb, t);

      if (!dead) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const pickWorker = (mx: number, my: number): AgentRecord | null => {
      for (const reg of layoutRef.current) {
        for (const wb of reg.workers) {
          if (Math.hypot(wb.x - mx, wb.y - (my - wb.size * 0.4)) < wb.size * 0.9) return wb.agent;
        }
      }
      return null;
    };
    const pickRegion = (mx: number, my: number): string | null => {
      for (const reg of layoutRef.current) {
        if (mx >= reg.x && mx <= reg.x + reg.w && my >= reg.y && my <= reg.y + reg.h) return reg.repo;
      }
      return null;
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      canvas.style.cursor = pickWorker(mx, my) || pickRegion(mx, my) ? 'pointer' : 'default';
    };
    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const ag = pickWorker(mx, my);
      if (ag) {
        setRepoSel(null);
        setSelected(ag);
        return;
      }
      const repo = pickRegion(mx, my);
      if (repo) {
        setSelected(null);
        setRepoSel(repo);
      }
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
  }, []);

  return (
    <div className="farm-wrap">
      <canvas ref={canvasRef} className="farm-canvas" />
      <div className="legend farm-legend">
        <span><span className="dot" style={{ background: C.accent }} />working (hoeing)</span>
        <span><span className="dot" style={{ background: C.red }} />blocked (frozen + !)</span>
        <span><span className="dot" style={{ background: C.amber }} />paused (sits, Zzz)</span>
        <span><span className="dot" style={{ background: C.green }} />done (✓ + sheaf)</span>
        <span><span className="dot" style={{ background: C.red }} />failed (slumps, ✕)</span>
        <span><span className="dot" style={{ background: C.dim }} />killed</span>
      </div>
      {selected && <AgentDrawer agent={selected} events={events} status={status} onClose={() => setSelected(null)} />}
      {!selected && repoSel && <RepoDrawer repo={repoSel} onClose={() => setRepoSel(null)} />}
    </div>
  );
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function drawRegion(c: CanvasRenderingContext2D, reg: Region, t: number) {
  // field body
  c.fillStyle = (reg.repo.charCodeAt(0) || 0) % 2 ? C.fieldA : C.fieldB;
  roundRect(c, reg.x, reg.y, reg.w, reg.h, 10);
  c.fill();

  // furrow rows (texture)
  c.save();
  roundRect(c, reg.x, reg.y, reg.w, reg.h, 10);
  c.clip();
  c.strokeStyle = C.furrow;
  c.lineWidth = 1;
  c.globalAlpha = 0.5;
  for (let yy = reg.y + HEADER_H + 18; yy < reg.y + reg.h - 6; yy += 22) {
    c.beginPath();
    c.moveTo(reg.x + 6, yy);
    c.lineTo(reg.x + reg.w - 6, yy);
    c.stroke();
  }
  c.globalAlpha = 1;
  c.restore();

  // fence border
  c.strokeStyle = C.fence;
  c.lineWidth = 1;
  roundRect(c, reg.x + 0.5, reg.y + 0.5, reg.w - 1, reg.h - 1, 10);
  c.stroke();

  // header sign band
  c.fillStyle = C.sign;
  roundRect(c, reg.x, reg.y, reg.w, HEADER_H, 10);
  c.fill();
  c.fillStyle = C.signEdge;
  c.fillRect(reg.x, reg.y + HEADER_H - 2, reg.w, 2);

  // repo name + counts
  c.textBaseline = 'middle';
  c.fillStyle = '#f1e7d8';
  c.font = '600 13px system-ui, sans-serif';
  c.textAlign = 'left';
  c.fillText(truncate(c, reg.repo, reg.w - 150), reg.x + 12, reg.y + HEADER_H / 2);
  c.fillStyle = '#e7d8c2';
  c.font = '11px ui-monospace, monospace';
  c.textAlign = 'right';
  const n = reg.workers.length;
  c.fillText(`${n} agent${n === 1 ? '' : 's'} · $${reg.cost.toFixed(2)}`, reg.x + reg.w - 12, reg.y + HEADER_H / 2);
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  void t;
}

function drawWorker(c: CanvasRenderingContext2D, wb: WorkerBox, t: number) {
  const a = wb.agent;
  const st = a.status;
  const s = wb.size;
  const body = modelColor(a.model);
  const outline = STATUS_COLOR[st] ?? C.accent;
  const phase = hashPhase(a.id);
  const x = wb.x;

  const working = st === 'working' || st === 'starting';
  const bobY = working ? Math.sin(t / 600 + phase) * 2 : st === 'paused' ? 1 : 0;
  const slump = st === 'failed';
  const y = wb.y + bobY;

  c.save();
  c.translate(x, y);

  // shadow
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.beginPath();
  c.ellipse(0, s * 0.5, s * 0.42, s * 0.16, 0, 0, Math.PI * 2);
  c.fill();

  // crop in front (grows while working; golden when done)
  if (working || st === 'done') {
    const grow = st === 'done' ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t / 1400 + phase));
    c.strokeStyle = st === 'done' ? C.wheat : C.crop;
    c.lineWidth = 1.5;
    for (let i = -1; i <= 1; i++) {
      const cx = i * s * 0.22;
      c.beginPath();
      c.moveTo(cx, s * 0.45);
      c.lineTo(cx, s * 0.45 - s * 0.32 * grow);
      c.stroke();
    }
  }

  if (slump) c.rotate(0.18);

  // legs
  c.strokeStyle = '#2a2f45';
  c.lineWidth = Math.max(2, s * 0.1);
  c.beginPath();
  c.moveTo(-s * 0.12, s * 0.32);
  c.lineTo(-s * 0.12, s * 0.46);
  c.moveTo(s * 0.12, s * 0.32);
  c.lineTo(s * 0.12, s * 0.46);
  c.stroke();

  // body
  c.fillStyle = slump ? C.failMuted : body;
  roundRect(c, -s * 0.26, -s * 0.18, s * 0.52, s * 0.5, s * 0.12);
  c.fill();
  c.lineWidth = 1.5;
  c.strokeStyle = outline;
  c.stroke();

  // arm + hoe (swing while working)
  if (working) {
    const swing = Math.sin(t / 300 + phase) * 0.5 - 0.3;
    c.save();
    c.translate(s * 0.2, -s * 0.02);
    c.rotate(swing);
    c.strokeStyle = '#9aa0b5';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(s * 0.34, -s * 0.18);
    c.stroke();
    c.fillStyle = '#c9cede';
    c.fillRect(s * 0.32, -s * 0.24, s * 0.12, s * 0.08);
    c.restore();
  }

  // head + straw hat
  c.fillStyle = C.skin;
  c.beginPath();
  c.arc(0, -s * 0.3, s * 0.16, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = C.hat;
  c.beginPath();
  c.moveTo(-s * 0.26, -s * 0.36);
  c.lineTo(s * 0.26, -s * 0.36);
  c.lineTo(0, -s * 0.56);
  c.closePath();
  c.fill();

  c.restore(); // undo slump rotate + translate

  // ---- status glyphs / badges (screen-upright, above the worker) ----
  c.save();
  c.translate(x, y);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const badgeY = -s * 0.72;
  if (st === 'blocked') {
    const bb = Math.sin(t / 320) * 1.5;
    c.fillStyle = C.red;
    roundRect(c, -6, badgeY - 8 + bb, 12, 16, 3);
    c.fill();
    c.fillStyle = '#fff';
    c.font = 'bold 11px system-ui';
    c.fillText('!', 0, badgeY + bb);
  } else if (st === 'paused') {
    c.fillStyle = C.amber;
    c.font = 'bold 11px system-ui';
    const zb = Math.sin(t / 500) * 2;
    c.fillText('z', s * 0.2, badgeY + zb);
    c.fillText('Z', s * 0.36, badgeY - 6 + zb);
  } else if (st === 'done') {
    c.fillStyle = C.green;
    c.font = 'bold 12px system-ui';
    c.fillText('✓', 0, badgeY);
  } else if (st === 'failed') {
    c.fillStyle = C.red;
    c.font = 'bold 12px system-ui';
    c.fillText('✕', 0, badgeY);
  }

  // event chips (float up + fade) — read from the module-level live ref
  drawChips(c, a.id, t, s);

  // name label
  c.fillStyle = C.muted;
  c.font = '10px system-ui, sans-serif';
  c.fillText(truncate(c, a.name, s * 2.4), 0, s * 0.72);
  c.restore();
}

// chips live on the component's wsRef; expose a thin module-level accessor set
// each frame from FarmView's effect via a shared symbol on the function object.
let CHIPS: Map<string, WState> | null = null;
function drawChips(c: CanvasRenderingContext2D, id: string, t: number, s: number) {
  const st = CHIPS?.get(id);
  if (!st || st.chips.length === 0) return;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const live = st.chips.filter((ch) => t - ch.born < 2500);
  live.forEach((ch, i) => {
    const age = t - ch.born;
    const a = 1 - age / 2500;
    const yy = -s * 0.95 - i * 12 - (age / 2500) * 10;
    c.globalAlpha = Math.max(0, a);
    c.fillStyle = ch.kind === 'tool' ? C.amber : C.accent;
    c.font = '9px ui-monospace, monospace';
    c.fillText(ch.text, 0, yy);
  });
  c.globalAlpha = 1;
}

function truncate(c: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
