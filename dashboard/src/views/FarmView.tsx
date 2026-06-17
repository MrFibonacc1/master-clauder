import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRecord, CortexEvent, StatusSnapshot, TaskRecord } from '../types';
import AgentDrawer from './AgentDrawer';
import RepoDrawer from './RepoDrawer';

// ---- palette (from spec Â§6) ----
const C = {
  bg: '#0d0e14',
  bgCard: '#181a26',
  lane: '#33302a',
  border: '#252836',
  skyTop: '#243047',
  skyHorizon: '#33415c',
  nightTop: '#0d1018',
  nightHorizon: '#161d2c',
  grassA: '#20351f',
  grassB: '#26401f',
  text: '#c9cede',
  muted: '#6b7188',
  barnFront: '#b5462f',
  barnSide: '#8e3422',
  roofA: '#6b4a2f',
  roofB: '#543a24',
  skin: '#caa472',
  hat: '#b8954f',
  wheat: '#e8c24a',
  accent: '#4dd6ff',
  violet: '#8b7cf6',
  green: '#4ade80',
  amber: '#fbbf24',
  red: '#f87171',
  failMuted: '#a85a5a',
  furrow: '#2a2620',
};

// model → constant torso color (identity)
function modelColor(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return C.violet;
  if (m.includes('sonnet')) return C.accent;
  if (m.includes('haiku')) return C.green;
  return C.muted;
}

// status → 1px torso outline + badge color
const STATUS_COLOR: Record<string, string> = {
  starting: C.amber,
  working: C.accent,
  blocked: C.red,
  paused: C.amber,
  done: C.green,
  failed: C.red,
  killed: C.muted,
};

const ease = (p: number) => p * p * (3 - 2 * p);
const bob = (t: number, period: number, amp: number) => Math.sin((t / period) * Math.PI * 2) * amp;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
function lerpHex(a: string, b: string, p: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const c = pa.map((x, i) => Math.round(lerp(x, pb[i], p)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function nightFactor(): number {
  // 0 = noon, 1 = midnight, smooth over a 24h wall clock.
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  // distance from noon (12) mapped to [0,1]
  const d = Math.abs(h - 12) / 12; // 0 at noon, 1 at midnight
  return clamp(d, 0, 1);
}

// ---- per-agent persistent animation state ----
interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
}
interface Chip {
  text: string;
  born: number;
  kind: 'tool' | 'message';
}
interface WorkerState {
  id: string;
  gx: number;
  gy: number; // current grid cell
  tgx: number;
  tgy: number; // target grid cell
  // walk tween
  walkFrom: { gx: number; gy: number } | null;
  walkStart: number;
  walkPhase: number;
  // status timing
  status: AgentStatusLite;
  statusSince: number;
  popStart: number; // for starting pop-in
  firstSwingDone: boolean;
  // visuals
  dust: Dust[];
  chips: Chip[];
  toolGlyph: string; // current held tool glyph key
  toolGlyphUntil: number;
  emphaticSwingUntil: number;
  killFadeStart: number;
  basket: number; // 0..1 cost gauge (eased)
  lastStrikeArc: number; // progress arc 0..1
}
type AgentStatusLite = AgentRecord['status'];

interface Plot {
  repo: string;
  bx: number; // barn grid coord
  by: number;
  field: { gx: number; gy: number }[]; // furrow cells
  spend: number;
}

interface WorkerLayout {
  state: WorkerState;
  agent: AgentRecord;
  // screen anchor recomputed each frame
}

// tool name → glyph key
function toolGlyph(name: string): string {
  const n = (name || '').toLowerCase();
  if (/(edit|write|build|create)/.test(n)) return 'hammer';
  if (/(read|search|grep|glob|find|ls)/.test(n)) return 'magnifier';
  if (/(fix|bash|run|patch)/.test(n)) return 'wrench';
  if (/(memory|note)/.test(n)) return 'scroll';
  return 'satchel';
}

export default function FarmView({ status, events }: { status: StatusSnapshot; events: CortexEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<AgentRecord | null>(null);
  const [repoSel, setRepoSel] = useState<string | null>(null);

  // persistent per-agent animation state across renders/frames
  const wsRef = useRef<Map<string, WorkerState>>(new Map());
  // golden sheaves left at barns by done agents (persist for session)
  const sheavesRef = useRef<Map<string, number>>(new Map()); // repo → count
  // last event id we've consumed for chips/ripples
  const lastEventIdRef = useRef<number>(0);
  // keep latest status/events accessible inside the rAF loop
  const statusRef = useRef(status);
  statusRef.current = status;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // repo set + plot packing (spiral). Memoized off the repo set so it only reflows on change.
  const repos = useMemo(() => {
    const set = new Set<string>([
      ...status.tasks.map((t) => t.repo).filter(Boolean),
      ...status.agents.map((a) => a.repo).filter(Boolean),
    ]);
    return [...set].sort();
  }, [status.tasks, status.agents]);

  const plots = useMemo<Plot[]>(() => {
    // spiral packing outward from the well (grid origin). Each plot gets a barn cell
    // plus a 2xN field of furrows offset from the barn so they never overlap.
    const out: Plot[] = [];
    // spiral ring offsets, each plot lives in a 5x5 grid neighbourhood
    const ringStep = 5;
    let ring = 1;
    let placed = 0;
    const positions: { gx: number; gy: number }[] = [];
    // generate enough positions
    while (positions.length < repos.length) {
      // walk the square ring at radius `ring`
      for (let gx = -ring; gx <= ring; gx++) {
        for (let gy = -ring; gy <= ring; gy++) {
          if (Math.max(Math.abs(gx), Math.abs(gy)) === ring) {
            positions.push({ gx: gx * ringStep, gy: gy * ringStep });
          }
        }
      }
      ring++;
      if (ring > 8) break;
    }
    for (const repo of repos) {
      const pos = positions[placed] ?? { gx: placed * ringStep, gy: 0 };
      placed++;
      const repoTasks = status.tasks.filter((t) => t.repo === repo).slice(0, 12);
      const field: { gx: number; gy: number }[] = [];
      for (let i = 0; i < Math.max(repoTasks.length, 2); i++) {
        const col = i % 2;
        const r = Math.floor(i / 2);
        field.push({ gx: pos.gx + 1.4 + col, gy: pos.gy + r });
      }
      const spend = status.costs.byTask
        ? Object.entries(status.costs.byTask)
            .filter(([taskId]) => status.tasks.find((t) => t.id === taskId)?.repo === repo)
            .reduce((s, [, v]) => s + v, 0)
        : 0;
      out.push({ repo, bx: pos.gx, by: pos.gy, field, spend });
    }
    return out;
  }, [repos, status.tasks, status.costs.byTask]);

  // build worker layouts: assign each agent to a field cell of its repo (anti-overlap)
  const workers = useMemo<WorkerLayout[]>(() => {
    const map = wsRef.current;
    const live = new Set<string>();
    const out: WorkerLayout[] = [];
    // per-repo cell cursor + occupancy for anti-overlap
    const cellCursor = new Map<string, number>();
    const occupied = new Map<string, number>(); // "gx,gy" → count

    for (const agent of status.agents) {
      live.add(agent.id);
      const plot = plots.find((p) => p.repo === agent.repo) ?? plots[0];
      // pick target cell: owned task's furrow, else barn dock for idle/starting/done
      let tgx: number;
      let tgy: number;
      const ownedTaskIdx = plot
        ? status.tasks.filter((t) => t.repo === plot.repo).findIndex((t) => t.ownerAgent === agent.id)
        : -1;
      const isField = agent.status === 'working' || agent.status === 'blocked' || agent.status === 'paused';
      if (plot && isField && ownedTaskIdx >= 0 && plot.field[ownedTaskIdx]) {
        tgx = plot.field[ownedTaskIdx].gx;
        tgy = plot.field[ownedTaskIdx].gy;
      } else if (plot && isField && plot.field.length) {
        // working but no explicit owned cell → next free field cell
        const c = cellCursor.get(plot.repo) ?? 0;
        cellCursor.set(plot.repo, c + 1);
        const cell = plot.field[Math.min(c, plot.field.length - 1)];
        tgx = cell.gx;
        tgy = cell.gy;
      } else if (plot) {
        // idle / starting / done dock at the barn front edge (queue up to 4, then half-row back)
        const dockKey = `dock:${plot.repo}`;
        const di = cellCursor.get(dockKey) ?? 0;
        cellCursor.set(dockKey, di + 1);
        const back = di >= 4 ? 0.5 : 0;
        tgx = plot.bx + 0.4 * (di % 4);
        tgy = plot.by + 1.2 + back;
      } else {
        tgx = 0;
        tgy = 0;
      }
      // anti-overlap: if cell taken, nudge +0.5 gy and one row back
      const key = `${tgx.toFixed(1)},${tgy.toFixed(1)}`;
      const n = occupied.get(key) ?? 0;
      occupied.set(key, n + 1);
      if (n > 0) {
        tgy += 0.5 * n;
        tgx += 0.1 * n;
      }

      let st = map.get(agent.id);
      const now = performance.now();
      if (!st) {
        // new worker → spawn at the well (origin) for the starting pop
        st = {
          id: agent.id,
          gx: agent.status === 'starting' ? 0 : tgx,
          gy: agent.status === 'starting' ? 0 : tgy,
          tgx,
          tgy,
          walkFrom: null,
          walkStart: 0,
          walkPhase: 0,
          status: agent.status,
          statusSince: now,
          popStart: now,
          firstSwingDone: false,
          dust: [],
          chips: [],
          toolGlyph: 'hoe',
          toolGlyphUntil: 0,
          emphaticSwingUntil: 0,
          killFadeStart: 0,
          basket: 0,
          lastStrikeArc: 0,
        };
        map.set(agent.id, st);
      }
      // status transition
      if (st.status !== agent.status) {
        st.status = agent.status;
        st.statusSince = now;
        if (agent.status === 'killed') st.killFadeStart = now;
        if (agent.status === 'starting') {
          st.popStart = now;
          st.firstSwingDone = false;
        }
      }
      // target change → start walk tween
      if (st.tgx !== tgx || st.tgy !== tgy) {
        st.walkFrom = { gx: st.gx, gy: st.gy };
        st.walkStart = now;
        st.tgx = tgx;
        st.tgy = tgy;
      }
      out.push({ state: st, agent });
    }
    // GC states for agents that disappeared
    for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
    return out;
  }, [status.agents, status.tasks, plots]);

  // record done agents → persistent golden sheaves at the barn (one per agent, deduped)
  const creditedDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of status.agents) {
      if (a.status === 'done' && !creditedDoneRef.current.has(a.id)) {
        creditedDoneRef.current.add(a.id);
        sheavesRef.current.set(a.repo, (sheavesRef.current.get(a.repo) ?? 0) + 1);
      }
    }
  }, [status.agents]);

  // render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let dead = false;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = Math.max(1, w * dpr);
      canvas.height = Math.max(1, h * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;

    // hover state
    let hoverId: string | null = null;
    let hoverRepo: string | null = null;

    // ---- iso projection ----
    const SKY = () => clamp(0.22 * H(), 90, 160);
    const origin = () => ({ x: W() / 2, y: SKY() + 40 });
    const isoToScreen = (gx: number, gy: number) => {
      const O = origin();
      return { x: O.x + (gx - gy) * 32, y: O.y + (gx + gy) * 16 };
    };

    // ---- consume new events → per-agent chips / tool glyphs ----
    const consumeEvents = (now: number) => {
      const evs = eventsRef.current;
      const map = wsRef.current;
      let maxId = lastEventIdRef.current;
      for (const e of evs) {
        if (e.id <= lastEventIdRef.current) continue;
        if (e.id > maxId) maxId = e.id;
        if (!e.agentId) continue;
        const st = map.get(e.agentId);
        if (!st) continue;
        if (e.type === 'agent.tool') {
          const name = String(e.payload.name ?? 'tool');
          st.toolGlyph = toolGlyph(name);
          st.toolGlyphUntil = now + 1500;
          st.emphaticSwingUntil = now + 600;
          if (st.chips.length < 3) st.chips.push({ text: name.slice(0, 16), born: now, kind: 'tool' });
        } else if (e.type === 'agent.message') {
          if (st.chips.length < 3) st.chips.push({ text: '…', born: now, kind: 'message' });
        }
      }
      lastEventIdRef.current = maxId;
    };

    // ---- drawing primitives ----
    const isoDiamond = (gx: number, gy: number, fill: string, scale = 1, alpha = 1) => {
      const p = isoToScreen(gx, gy);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 16 * scale);
      ctx.lineTo(p.x + 32 * scale, p.y);
      ctx.lineTo(p.x, p.y + 16 * scale);
      ctx.lineTo(p.x - 32 * scale, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    const shadowEllipse = (sx: number, sy: number, rx: number, ry: number) => {
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(sx, sy + 3, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawSky = (night: number) => {
      const top = lerpHex(C.skyTop, C.nightTop, night);
      const hor = lerpHex(C.skyHorizon, C.nightHorizon, night);
      const g = ctx.createLinearGradient(0, 0, 0, SKY());
      g.addColorStop(0, top);
      g.addColorStop(1, hor);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W(), SKY());
    };

    const drawSunMoon = (night: number) => {
      const x = 0.14 * W();
      const y = lerp(SKY() * 0.42, SKY() * 0.95, night);
      const isMoon = night > 0.6;
      const fill = isMoon ? '#cfd6e6' : C.amber;
      // halo
      ctx.fillStyle = fill;
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.arc(x, y, 30, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawClouds = (t: number, night: number) => {
      const alpha = lerp(0.1, 0.04, night);
      ctx.fillStyle = `rgba(201,206,222,${alpha})`;
      const speed = 6; // px/s
      for (let c = 0; c < 3; c++) {
        const base = ((t / 1000) * speed + c * (W() / 3)) % (W() + 120);
        const cx = base - 60;
        const cy = SKY() * (0.25 + 0.18 * c);
        for (let e = 0; e < 3; e++) {
          ctx.beginPath();
          ctx.ellipse(cx + e * 18 - 18, cy + (e === 1 ? -4 : 0), 22 - e * 3, 10 - e, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const drawGround = (night: number) => {
      ctx.fillStyle = C.bgCard;
      ctx.fillRect(0, SKY(), W(), H() - SKY());
      // iso grass field around the visible plot span
      const a = lerpHex(C.grassA, '#10180f', night * 0.6);
      const b = lerpHex(C.grassB, '#13200f', night * 0.6);
      for (let gx = -14; gx <= 14; gx++) {
        for (let gy = -14; gy <= 14; gy++) {
          const p = isoToScreen(gx, gy);
          if (p.y < SKY() - 20 || p.y > H() + 20 || p.x < -40 || p.x > W() + 40) continue;
          isoDiamond(gx, gy, (gx + gy) % 2 === 0 ? a : b);
          // faint tile grid
          ctx.strokeStyle = 'rgba(120,130,170,0.05)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - 16);
          ctx.lineTo(p.x + 32, p.y);
          ctx.lineTo(p.x, p.y + 16);
          ctx.lineTo(p.x - 32, p.y);
          ctx.closePath();
          ctx.stroke();
        }
      }
    };

    const drawFootpaths = () => {
      // tan diamonds connecting each barn to the well at origin
      for (const plot of plots) {
        const steps = 6;
        for (let i = 0; i <= steps; i++) {
          const gx = (plot.bx * i) / steps;
          const gy = (plot.by * i) / steps;
          isoDiamond(gx, gy, C.lane, 0.5, 0.5);
        }
      }
    };

    const drawWell = (night: number) => {
      const p = isoToScreen(0, 0);
      shadowEllipse(p.x, p.y, 14, 7);
      // stone ring
      ctx.fillStyle = '#3a3f55';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 12, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0b10';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 7, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // little roof posts
      ctx.strokeStyle = C.roofA;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - 10, p.y - 2);
      ctx.lineTo(p.x - 10, p.y - 16);
      ctx.moveTo(p.x + 10, p.y - 2);
      ctx.lineTo(p.x + 10, p.y - 16);
      ctx.stroke();
      ctx.fillStyle = C.roofB;
      ctx.beginPath();
      ctx.moveTo(p.x - 14, p.y - 16);
      ctx.lineTo(p.x, p.y - 22);
      ctx.lineTo(p.x + 14, p.y - 16);
      ctx.closePath();
      ctx.fill();
      void night;
    };

    const drawBarn = (plot: Plot, dim: boolean) => {
      const p = isoToScreen(plot.bx, plot.by);
      const agentCount = statusRef.current.agents.filter((a) => a.repo === plot.repo).length;
      const taskCount = statusRef.current.tasks.filter((t) => t.repo === plot.repo).length;
      const sizeBump = clamp((agentCount + taskCount) * 0.04, 0, 0.4);
      const s = 1 + sizeBump;
      ctx.save();
      if (dim) ctx.globalAlpha = 0.45;
      shadowEllipse(p.x, p.y, 26 * s, 12 * s);
      // front wall quad
      const wallH = 26 * s;
      const wallW = 22 * s;
      ctx.fillStyle = C.barnFront;
      ctx.beginPath();
      ctx.moveTo(p.x - wallW, p.y - 4);
      ctx.lineTo(p.x, p.y + 8);
      ctx.lineTo(p.x, p.y + 8 - wallH);
      ctx.lineTo(p.x - wallW, p.y - 4 - wallH);
      ctx.closePath();
      ctx.fill();
      // side wall quad
      ctx.fillStyle = C.barnSide;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 8);
      ctx.lineTo(p.x + wallW, p.y - 4);
      ctx.lineTo(p.x + wallW, p.y - 4 - wallH);
      ctx.lineTo(p.x, p.y + 8 - wallH);
      ctx.closePath();
      ctx.fill();
      // gabled roof
      const roofY = p.y - 4 - wallH;
      ctx.fillStyle = C.roofA;
      ctx.beginPath();
      ctx.moveTo(p.x - wallW, roofY);
      ctx.lineTo(p.x, roofY - 14 * s);
      ctx.lineTo(p.x, roofY + 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = C.roofB;
      ctx.beginPath();
      ctx.moveTo(p.x + wallW, roofY);
      ctx.lineTo(p.x, roofY - 14 * s);
      ctx.lineTo(p.x, roofY + 12);
      ctx.closePath();
      ctx.fill();
      // hayloft window
      ctx.fillStyle = '#1a120c';
      ctx.beginPath();
      ctx.arc(p.x - wallW * 0.5, roofY - 2, 4 * s, 0, Math.PI * 2);
      ctx.fill();
      // door — openness reflects active agents
      const active = statusRef.current.agents.some((a) => a.repo === plot.repo && (a.status === 'working' || a.status === 'starting'));
      ctx.fillStyle = active ? '#241008' : '#3a1c10';
      ctx.fillRect(p.x - wallW * 0.55, p.y - 4 - wallH * 0.5, wallW * 0.3, wallH * 0.5);

      // sign plank
      const spend = plot.spend;
      const glow = spend > (statusRef.current.budget.perTaskUsd || 5) * 0.8;
      ctx.fillStyle = '#5a4329';
      const plankY = roofY - 14 * s - 14;
      ctx.fillRect(p.x - 30, plankY, 60, 14);
      if (glow) {
        ctx.shadowColor = C.amber;
        ctx.shadowBlur = 10;
        ctx.fillStyle = 'rgba(251,191,36,0.15)';
        ctx.fillRect(p.x - 30, plankY, 60, 14);
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = C.text;
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(plot.repo.length > 10 ? plot.repo.slice(0, 9) + '…' : plot.repo, p.x, plankY + 7);

      // grain silo beside barn (per-repo spend)
      const cap = (statusRef.current.budget.perTaskUsd || 5) * 2;
      const fillRatio = clamp(spend / cap, 0, 1);
      const sx = p.x + wallW + 12;
      const sy = p.y;
      ctx.fillStyle = '#2a2d3c';
      ctx.fillRect(sx, sy - 28, 12, 28);
      ctx.fillStyle = C.wheat;
      ctx.fillRect(sx, sy - 28 * fillRatio, 12, 28 * fillRatio);
      ctx.fillStyle = '#3a3f55';
      ctx.beginPath();
      ctx.moveTo(sx - 2, sy - 28);
      ctx.lineTo(sx + 6, sy - 36);
      ctx.lineTo(sx + 14, sy - 28);
      ctx.closePath();
      ctx.fill();
      if (spend > 0) {
        ctx.fillStyle = C.muted;
        ctx.font = '9px ui-monospace, Menlo, monospace';
        ctx.fillText(`$${spend.toFixed(2)}`, sx + 6, sy + 10);
      }

      // persistent golden sheaves left by done agents
      const sheaves = sheavesRef.current.get(plot.repo) ?? 0;
      for (let i = 0; i < Math.min(sheaves, 6); i++) {
        ctx.fillStyle = C.wheat;
        const hx = p.x - wallW * 0.4 + i * 5;
        const hy = p.y + 4;
        ctx.fillRect(hx, hy, 3, 8);
      }

      ctx.restore();

      // field furrows
      for (const cell of plot.field) {
        const fp = isoToScreen(cell.gx, cell.gy);
        ctx.strokeStyle = C.furrow;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fp.x - 20, fp.y);
        ctx.lineTo(fp.x + 20, fp.y);
        ctx.stroke();
      }
    };

    // seedling for a task at a field cell
    const drawSeedling = (gx: number, gy: number, task: TaskRecord | undefined, t: number) => {
      const p = isoToScreen(gx, gy);
      shadowEllipse(p.x, p.y, 5, 2.5);
      const st = task?.status ?? 'pending';
      const tint = task ? modelColor(task.model) : C.green;
      const sway = bob(t, 1500, 1);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (st === 'pending' || st === 'planning') {
        ctx.fillStyle = '#3a2e22';
        ctx.beginPath();
        ctx.ellipse(0, 0, 5, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = C.green;
        ctx.fillRect(-0.5, -3, 1, 3);
      } else if (st === 'running') {
        ctx.strokeStyle = tint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(sway, -9);
        ctx.stroke();
        ctx.fillStyle = tint;
        ctx.beginPath();
        ctx.ellipse(sway - 2, -7, 2.5, 1.5, -0.6, 0, Math.PI * 2);
        ctx.ellipse(sway + 2, -5, 2.5, 1.5, 0.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (st === 'awaiting-merge') {
        ctx.strokeStyle = tint;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(sway * 0.5, -13);
        ctx.stroke();
        ctx.fillStyle = C.amber;
        ctx.beginPath();
        ctx.arc(sway * 0.5, -14, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (st === 'done') {
        ctx.fillStyle = C.wheat;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-3, -12);
        ctx.lineTo(0, -10);
        ctx.lineTo(3, -12);
        ctx.closePath();
        ctx.fill();
      } else if (st === 'blocked') {
        ctx.strokeStyle = tint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -9);
        ctx.stroke();
        ctx.strokeStyle = C.red;
        ctx.beginPath();
        ctx.moveTo(2, -1);
        ctx.lineTo(5, -4);
        ctx.lineTo(3, -6);
        ctx.lineTo(6, -9);
        ctx.stroke();
      } else if (st === 'failed') {
        ctx.strokeStyle = '#6b4a2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(3, -5, 6, -4);
        ctx.stroke();
        ctx.strokeStyle = C.muted;
        ctx.beginPath();
        ctx.moveTo(-3, 0);
        ctx.lineTo(-3, -8);
        ctx.stroke();
      } else if (st === 'killed') {
        ctx.strokeStyle = '#4a5a3f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -5);
        ctx.stroke();
      }
      ctx.restore();
    };

    // ---- worker drawing ----
    const drawWorker = (wl: WorkerLayout, t: number) => {
      const w = wl.state;
      const agent = wl.agent;
      // resolve walk tween → current screen anchor
      let cgx = w.gx;
      let cgy = w.gy;
      let walking = false;
      if (w.walkFrom) {
        const dur = 600;
        const p = clamp((t - w.walkStart) / dur, 0, 1);
        const e = ease(p);
        cgx = lerp(w.walkFrom.gx, w.tgx, e);
        cgy = lerp(w.walkFrom.gy, w.tgy, e);
        w.gx = cgx;
        w.gy = cgy;
        walking = p < 1;
        if (p >= 1) w.walkFrom = null;
        else w.walkPhase += 0.08;
        // dust trail
        if (walking && Math.floor(t / 120) !== Math.floor((t - 16) / 120)) {
          const sp = isoToScreen(cgx, cgy);
          w.dust.push({ x: sp.x, y: sp.y, vx: 0, vy: 0.2, born: t });
        }
      }
      const P = isoToScreen(cgx, cgy);
      const status = agent.status;
      const stroke = STATUS_COLOR[status] ?? C.accent;
      const facingRight = cgx - cgy >= 0;

      // status pop-in for starting
      let popScale = 1;
      if (status === 'starting') {
        const p = clamp((t - w.popStart) / 240, 0, 1);
        popScale = ease(p);
        // dust ring
        if (p < 1) {
          const r = lerp(8, 18, p);
          ctx.strokeStyle = `rgba(251,191,36,${1 - p})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(P.x, P.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // killed fade → scarecrow
      let killAlpha = 1;
      let isScarecrow = false;
      if (status === 'killed') {
        const p = clamp((t - w.killFadeStart) / 600, 0, 1);
        killAlpha = 1 - p;
        if (p >= 1) isScarecrow = true;
      }

      // shadow (pass 6 spirit — drawn just before object so it doesn't overlap fills)
      shadowEllipse(P.x, P.y, 8, 4);

      if (isScarecrow) {
        // cross-post + straw head
        ctx.strokeStyle = C.muted;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(P.x, P.y);
        ctx.lineTo(P.x, P.y - 20);
        ctx.moveTo(P.x - 8, P.y - 14);
        ctx.lineTo(P.x + 8, P.y - 14);
        ctx.stroke();
        ctx.fillStyle = C.hat;
        ctx.beginPath();
        ctx.arc(P.x, P.y - 22, 4, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      ctx.save();
      ctx.globalAlpha = killAlpha;
      // scale-pop for starting (anchored at the worker's feet)
      if (popScale < 1) {
        ctx.translate(P.x, P.y);
        ctx.scale(popScale, popScale);
        ctx.translate(-P.x, -P.y);
      }

      // breathing + status bob
      let bobY = bob(t, 1200, 1);
      let sitDrop = 0;
      let slumpTilt = 0;
      let torsoFill = modelColor(agent.model);
      let torsoAlpha = 1;
      if (status === 'starting' && !w.firstSwingDone) torsoAlpha = 0.6;
      if (status === 'paused') {
        sitDrop = 5;
        bobY = bob(t, 1600, 0.6);
        torsoFill = lerpHex(torsoFill, '#888', 0.3); // desaturate
      }
      if (status === 'failed') {
        slumpTilt = 0.21; // ~12deg
        torsoFill = C.failMuted;
        bobY = 0;
      }

      // --- legs ---
      const legSwing = walking ? Math.sin(w.walkPhase) * 3 : 0;
      ctx.fillStyle = '#3a2e22';
      if (status === 'paused') {
        // crossed/folded legs: one rect
        ctx.fillRect(P.x - 4, P.y - 3 + sitDrop, 8, 3);
      } else {
        ctx.save();
        ctx.translate(P.x - 1.5, P.y - 6);
        ctx.rotate((legSwing * Math.PI) / 180);
        ctx.fillRect(-1.5, 0, 3, 6);
        ctx.restore();
        ctx.save();
        ctx.translate(P.x + 1.5, P.y - 6);
        ctx.rotate((-legSwing * Math.PI) / 180);
        ctx.fillRect(-1.5, 0, 3, 6);
        ctx.restore();
      }

      // --- torso (rounded rect) ---
      const torsoY = P.y - 18 + bobY + sitDrop;
      ctx.save();
      ctx.translate(P.x, torsoY + 6);
      ctx.rotate(slumpTilt * (facingRight ? 1 : -1));
      ctx.globalAlpha = killAlpha * torsoAlpha;
      roundRect(ctx, -5, -6, 10, 12, 2);
      ctx.fillStyle = torsoFill;
      ctx.fill();
      ctx.globalAlpha = killAlpha;
      ctx.lineWidth = 1;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      // torso glyph: first letter of name
      ctx.fillStyle = C.bg;
      ctx.font = '8px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((agent.name || '?')[0].toUpperCase(), 0, 0);
      ctx.restore();

      // --- head ---
      const headY = P.y - 22 + bobY + sitDrop + (status === 'failed' ? 3 : 0);
      ctx.fillStyle = C.skin;
      ctx.beginPath();
      ctx.arc(P.x, headY, 4, 0, Math.PI * 2);
      ctx.fill();
      // --- straw hat brim ---
      ctx.fillStyle = C.hat;
      ctx.beginPath();
      ctx.ellipse(P.x, headY - 2, 6, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(P.x, headY - 3, 3, Math.PI, 0);
      ctx.fill();

      // --- held tool + arm ---
      const handX = P.x + (facingRight ? 4 : -4);
      const handY = P.y - 14 + bobY + sitDrop;
      let armAngle = facingRight ? -0.6 : 0.6 + Math.PI;
      const swingAmp = 0.9;
      const emphatic = t < w.emphaticSwingUntil;
      if (status === 'working' || emphatic) {
        // shared beat: all working agents share t/600 phase
        armAngle = (facingRight ? -0.6 : Math.PI + 0.6) + Math.sin((t / 600) * Math.PI * 2) * swingAmp;
        // strike detection (downstroke zero-cross) → dust + arc
        const phase = (t / 600) * Math.PI * 2;
        if (Math.sin(phase) > 0.95) {
          if (Math.floor(t / 600) !== Math.floor((t - 16) / 600)) {
            for (let i = 0; i < 3; i++) {
              w.dust.push({ x: handX, y: P.y, vx: (Math.random() - 0.5) * 0.6, vy: -0.4, born: t });
            }
            w.firstSwingDone = true;
            w.lastStrikeArc = clamp(w.lastStrikeArc + 0.08, 0, 1);
          }
        }
      } else if (status === 'blocked') {
        // frozen mid-swing at top of arc
        armAngle = (facingRight ? -0.6 : Math.PI + 0.6) - swingAmp;
      } else if (status === 'paused') {
        armAngle = facingRight ? 0.1 : Math.PI - 0.1; // tool laid flat
      }

      if (status === 'failed' || isScarecrow) {
        // tool dropped: static line on the ground beside it
        ctx.strokeStyle = C.muted;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(P.x + 6, P.y);
        ctx.lineTo(P.x + 14, P.y - 1);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(handX, handY);
        ctx.rotate(armAngle);
        ctx.strokeStyle = '#6b4a2f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(10, 0);
        ctx.stroke();
        drawToolTip(ctx, 10, 0, t < w.toolGlyphUntil ? w.toolGlyph : 'hoe');
        ctx.restore();
      }

      // working progress arc around feet
      if (status === 'working') {
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(P.x, P.y, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * w.lastStrikeArc);
        ctx.stroke();
        // per-agent harvest basket (cost gauge)
        drawBasket(ctx, P.x - 12, P.y, agent.id);
      }

      // status badges / particles
      if (status === 'blocked') {
        const by = headY - 12 + bob(t, 2000, 2);
        ctx.fillStyle = C.red;
        roundRect(ctx, P.x - 5, by - 8, 10, 12, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 9px ui-monospace, Menlo, monospace';
        ctx.fillText('!', P.x, by - 2);
      } else if (status === 'paused') {
        const zp = ((t / 3000) % 1);
        ctx.fillStyle = `rgba(251,191,36,${1 - zp})`;
        ctx.font = '9px ui-monospace, Menlo, monospace';
        ctx.fillText('Zzz', P.x + 8, headY - 6 - zp * 14);
      } else if (status === 'done') {
        ctx.fillStyle = C.green;
        ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
        ctx.fillText('✓', P.x, headY - 10);
        // sparkles
        if (Math.floor(t / 400) % 2 === 0) {
          ctx.fillStyle = C.wheat;
          ctx.font = '8px ui-monospace, Menlo, monospace';
          ctx.fillText('+', P.x + 8, headY - 4);
        }
      } else if (status === 'failed') {
        ctx.fillStyle = C.red;
        ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
        ctx.fillText('✕', P.x, headY - 8);
        // smoke wisp
        const sp = (t / 1500) % 1;
        ctx.strokeStyle = `rgba(140,140,150,${0.4 * (1 - sp)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(P.x + 4, P.y - 4);
        ctx.quadraticCurveTo(P.x + 8, P.y - 12 - sp * 8, P.x + 4, P.y - 20 - sp * 10);
        ctx.stroke();
      }

      ctx.restore();

      // dust particles (drawn after, on top of ground)
      w.dust = w.dust.filter((d) => t - d.born < 700);
      for (const d of w.dust) {
        const age = (t - d.born) / 700;
        d.x += d.vx;
        d.y += d.vy;
        ctx.fillStyle = `rgba(180,160,130,${0.5 * (1 - age)})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 1.5 * (1 - age) + 0.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // event chips above the hat (max 3, queued)
      w.chips = w.chips.filter((c) => t - c.born < 1300);
      w.chips.slice(0, 3).forEach((c, i) => {
        const age = (t - c.born) / 1300;
        const cy = headY - 16 - i * 13 - age * 10;
        ctx.globalAlpha = 1 - age;
        if (c.kind === 'tool') {
          const tw = ctx.measureText(c.text).width + 8;
          ctx.fillStyle = C.bgCard;
          roundRect(ctx, P.x - tw / 2, cy - 7, tw, 12, 3);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = C.text;
          ctx.font = '9px ui-monospace, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(c.text, P.x, cy);
        } else {
          // speech bubble with 3 dots
          ctx.fillStyle = C.bgCard;
          roundRect(ctx, P.x - 10, cy - 6, 20, 11, 4);
          ctx.fill();
          ctx.fillStyle = C.text;
          for (let d = 0; d < 3; d++) {
            ctx.beginPath();
            ctx.arc(P.x - 5 + d * 5, cy, 1.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      });

      // hover name tag + gentle hop spotlight
      if (hoverId === agent.id || selected?.id === agent.id) {
        ctx.fillStyle = '#5a4329';
        const label = agent.name;
        ctx.font = '10px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(label).width + 10;
        roundRect(ctx, P.x - tw / 2, headY - 30, tw, 14, 3);
        ctx.fill();
        ctx.fillStyle = C.text;
        ctx.textAlign = 'center';
        ctx.fillText(label, P.x, headY - 23);
        // selection ring
        if (selected?.id === agent.id) {
          ctx.strokeStyle = C.accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.ellipse(P.x, P.y, 11, 6, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // store screen bbox for hit-testing
      hitBoxes.push({ id: agent.id, agent, x0: P.x - 7, x1: P.x + 7, y0: P.y - 26, y1: P.y, sort: cgx + cgy });
    };

    const drawBasket = (c: CanvasRenderingContext2D, x: number, y: number, agentId: string) => {
      const cost = statusRef.current.costs.byAgent[agentId] ?? 0;
      const cap = statusRef.current.budget.perTaskUsd || 5;
      const warn = statusRef.current.budget.warnRatio || 0.8;
      const ratio = clamp(cost / cap, 0, 1.2);
      let col = C.green;
      if (ratio > 1) col = C.red;
      else if (ratio > warn) col = C.amber;
      c.fillStyle = '#3a2e22';
      c.fillRect(x - 4, y - 5, 8, 5);
      c.fillStyle = col;
      const fh = clamp(ratio, 0, 1) * 5;
      c.fillRect(x - 4, y - fh, 8, fh);
      if (ratio > 1) {
        // overflowing crop icons
        c.fillStyle = C.wheat;
        c.fillRect(x - 3, y - 7, 1.5, 2);
        c.fillRect(x + 1, y - 8, 1.5, 2);
      }
    };

    // event ripples that fly between worker/barn: memory + routed seeds
    interface FlyParticle {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      born: number;
      kind: 'memory-read' | 'memory-write' | 'seed';
      color: string;
    }
    const flyers: FlyParticle[] = [];
    const consumeFlyEvents = (now: number) => {
      // re-scan recent events for memory/routed (we track via lastEventIdRef shared with consumeEvents,
      // so do memory/routed here BEFORE consumeEvents bumps the id).
      const evs = eventsRef.current;
      for (const e of evs) {
        if (e.id <= lastEventIdRef.current) continue;
        if (e.type === 'agent.memory' && e.agentId) {
          const st = wsRef.current.get(e.agentId);
          if (!st) continue;
          const worker = isoToScreen(st.gx, st.gy);
          const plot = plots.find((p) => p.repo === workerRepo(e.agentId));
          const barn = plot ? isoToScreen(plot.bx, plot.by) : worker;
          const write = String(e.payload.op ?? '').includes('write') || String(e.payload.op ?? '') === 'put';
          flyers.push({
            x0: write ? worker.x : barn.x,
            y0: write ? worker.y - 14 : barn.y - 30,
            x1: write ? barn.x : worker.x,
            y1: write ? barn.y - 30 : worker.y - 14,
            born: now,
            kind: write ? 'memory-write' : 'memory-read',
            color: C.violet,
          });
        } else if (e.type === 'task.routed' && e.taskId) {
          const task = statusRef.current.tasks.find((t) => t.id === e.taskId);
          const plot = task ? plots.find((p) => p.repo === task.repo) : undefined;
          if (!plot) continue;
          const well = isoToScreen(0, 0);
          const cell = plot.field[0] ?? { gx: plot.bx, gy: plot.by };
          const dest = isoToScreen(cell.gx, cell.gy);
          flyers.push({ x0: well.x, y0: well.y - 10, x1: dest.x, y1: dest.y, born: now, kind: 'seed', color: task ? modelColor(task.model) : C.wheat });
        }
      }
    };
    const workerRepo = (agentId: string | undefined) => statusRef.current.agents.find((a) => a.id === agentId)?.repo ?? '';

    const drawFlyers = (now: number) => {
      for (let i = flyers.length - 1; i >= 0; i--) {
        const f = flyers[i];
        const dur = f.kind === 'seed' ? 700 : 900;
        const p = (now - f.born) / dur;
        if (p >= 1) {
          flyers.splice(i, 1);
          continue;
        }
        const e = ease(p);
        const x = lerp(f.x0, f.x1, e);
        const arc = Math.sin(p * Math.PI) * (f.kind === 'seed' ? 24 : 10);
        const y = lerp(f.y0, f.y1, e) - arc;
        ctx.fillStyle = f.color;
        if (f.kind === 'seed') {
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // scroll glyph
          ctx.fillRect(x - 3, y - 2, 6, 4);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x - 2, y);
          ctx.lineTo(x + 2, y);
          ctx.stroke();
        }
      }
    };

    let hitBoxes: { id: string; agent: AgentRecord; x0: number; x1: number; y0: number; y1: number; sort: number }[] = [];

    const drawHUD = () => {
      const s = statusRef.current;
      ctx.fillStyle = 'rgba(13,14,20,0.7)';
      roundRect(ctx, 12, 12, 200, 22, 6);
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${plots.length} repos · ${s.agents.length} agents · $${s.daySpendUsd.toFixed(2)}`, 20, 23);
    };

    const draw = (t: number) => {
      const night = nightFactor();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, W(), H());
      hitBoxes = [];

      // 1-3 sky
      drawSky(night);
      drawSunMoon(night);
      drawClouds(t, night);
      // 4-5 ground + paths + well
      drawGround(night);
      drawFootpaths();
      drawWell(night);

      // 7 barns (painter order by gx+gy) with hover dim
      const orderedPlots = [...plots].sort((a, b) => a.bx + a.by - (b.bx + b.by));
      for (const plot of orderedPlots) {
        const dim = hoverRepo != null && hoverRepo !== plot.repo;
        drawBarn(plot, dim);
        // seedlings on this plot's field
        const repoTasks = statusRef.current.tasks.filter((tk) => tk.repo === plot.repo);
        plot.field.forEach((cell, i) => drawSeedling(cell.gx, cell.gy, repoTasks[i], t));
      }

      // 8 workers (painter order by gx+gy)
      const ordered = [...workers].sort((a, b) => a.state.gx + a.state.gy - (b.state.gx + b.state.gy));
      for (const wl of ordered) drawWorker(wl, t);

      // 9 event flyers / overlays
      consumeFlyEvents(t);
      consumeEvents(t);
      drawFlyers(t);

      // 10 HUD
      drawHUD();
    };

    const loop = (t: number) => {
      if (dead) return;
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // ---- hit testing (iso-aware, front-to-back) ----
    const pick = (mx: number, my: number): AgentRecord | null => {
      const sorted = [...hitBoxes].sort((a, b) => b.sort - a.sort); // front first
      for (const h of sorted) {
        if (mx >= h.x0 && mx <= h.x1 && my >= h.y0 && my <= h.y1) return h.agent;
      }
      return null;
    };
    const pickRepo = (mx: number, my: number): string | null => {
      // hover a barn → return its repo (coarse bbox around barn anchor)
      for (const plot of plots) {
        const p = isoToScreen(plot.bx, plot.by);
        if (mx >= p.x - 26 && mx <= p.x + 26 && my >= p.y - 50 && my <= p.y + 10) return plot.repo;
      }
      return null;
    };

    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const hit = pick(mx, my);
      hoverId = hit?.id ?? null;
      hoverRepo = hit ? null : pickRepo(mx, my);
      canvas.style.cursor = hit || hoverRepo ? 'pointer' : 'default';
    };
    const onClick = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const hit = pick(mx, my);
      if (hit) {
        setSelected(hit);
        setRepoSel(null);
        return;
      }
      const repo = pickRepo(mx, my);
      setSelected(null);
      setRepoSel(repo);
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
    // re-run when the layout (plots/workers) changes so closures see fresh data
  }, [plots, workers, selected]);

  return (
    <div className="farm-wrap">
      <canvas ref={canvasRef} className="farm-canvas" />
      <div className="legend farm-legend">
        <span><span className="dot" style={{ background: C.accent }} />working (swinging)</span>
        <span><span className="dot" style={{ background: C.red }} />blocked (frozen + !)</span>
        <span><span className="dot" style={{ background: C.amber }} />paused (sits, Zzz)</span>
        <span><span className="dot" style={{ background: C.green }} />done (✓ + sheaf)</span>
        <span><span className="dot" style={{ background: C.red }} />failed (slumps, ✕)</span>
        <span><span className="dot" style={{ background: C.muted }} />killed (scarecrow)</span>
      </div>
      {selected && <AgentDrawer agent={selected} events={events} status={status} onClose={() => setSelected(null)} />}
      {!selected && repoSel && <RepoDrawer repo={repoSel} onClose={() => setRepoSel(null)} />}
    </div>
  );
}

// rounded rect helper (path only; caller fills/strokes)
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

// tool-tip glyph drawn at local (x,y) within the rotated arm transform
function drawToolTip(c: CanvasRenderingContext2D, x: number, y: number, glyph: string) {
  c.save();
  c.translate(x, y);
  switch (glyph) {
    case 'hammer':
      c.fillStyle = '#9aa0b5';
      c.fillRect(-1, -4, 5, 4);
      break;
    case 'magnifier':
      c.strokeStyle = '#9aa0b5';
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(2, -2, 2.5, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(4, 0);
      c.lineTo(6, 2);
      c.stroke();
      break;
    case 'wrench':
      c.strokeStyle = '#9aa0b5';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(4, -3);
      c.stroke();
      c.beginPath();
      c.arc(4, -3, 1.5, 0, Math.PI * 2);
      c.stroke();
      break;
    case 'scroll':
      c.fillStyle = '#8b7cf6';
      c.fillRect(-1, -4, 4, 5);
      break;
    case 'satchel':
      c.fillStyle = '#6b4a2f';
      c.fillRect(-1, -3, 4, 4);
      break;
    case 'hoe':
    default:
      c.fillStyle = '#9aa0b5';
      c.fillRect(-1, -3, 3, 2);
      break;
  }
  c.restore();
}
