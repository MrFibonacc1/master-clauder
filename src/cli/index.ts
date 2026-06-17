#!/usr/bin/env node
/**
 * cortex — CLI entry point.
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, saveConfig, registerRepo } from '../core/config.js';
import type { CortexConfig, CortexEvent, Tier } from '../shared/types.js';
import { Hub } from './hub.js';
import { startServer } from './server.js';
import { Brain } from '../core/brain.js';

const program = new Command();
program.name('cortex').description('Cortex — local-first multi-agent coding orchestrator').version('0.1.0');

/** Write the standard repo brain note for a newly registered repo. */
async function writeRepoNote(cfg: CortexConfig, name: string, repoPath: string, mainBranch?: string): Promise<void> {
  const brain = new Brain(cfg.vaultPath);
  await brain.ensureVault();
  await brain.writeNote({
    relPath: `repos/${name}/repo.md`,
    title: name,
    scope: 'repo',
    repo: name,
    type: 'convention',
    tags: ['repo'],
    pinned: true,
    created: new Date().toISOString().slice(0, 10),
    body: `Repo **${name}** registered at \`${repoPath}\` (main branch: ${mainBranch ?? 'main'}).`,
    links: [],
  });
}

/** Find the git toplevel of cwd, if any. */
function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Claude-CLI-like repo resolution: prefer the registered repo containing cwd;
 * if cwd is inside an unregistered git repo, auto-register it.
 */
async function resolveRepoForCwd(cfg: CortexConfig): Promise<string | undefined> {
  const top = gitToplevel(process.cwd());
  if (top) {
    const existing = Object.values(cfg.repos).find((r) => path.resolve(r.path) === top);
    if (existing) return existing.name;
    const rc = registerRepo(cfg, top);
    await writeRepoNote(cfg, rc.name, rc.path, rc.mainBranch);
    console.log(pc.dim(`Auto-registered repo "${rc.name}" (${rc.path})`));
    return rc.name;
  }
  const names = Object.keys(cfg.repos);
  return names.length === 1 ? names[0] : undefined;
}

/** Start the dashboard server on the hub, tolerating an already-used port.
 *  `owned` is true when THIS process bound the port (vs another cortex session). */
async function startDashboard(hub: Hub, open = false): Promise<{ url: string; owned: boolean }> {
  const port = hub.config.dashboardPort;
  const url = `http://localhost:${port}`;
  try {
    await startServer(hub, port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw err;
    console.log(pc.dim(`Dashboard port ${port} already in use — assuming another cortex session is serving it.`));
    return { url, owned: false };
  }
  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
  return { url, owned: true };
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function printEvent(e: CortexEvent): void {
  const t = new Date(e.ts).toLocaleTimeString();
  const who = e.agentId ? pc.cyan(e.agentId.slice(-6)) : pc.dim('hub');
  let body: string;
  switch (e.type) {
    case 'agent.message':
      body = pc.white(String(e.payload.text ?? '').slice(0, 200));
      break;
    case 'agent.tool':
      body = pc.yellow(`${e.payload.name}: ${String(e.payload.summary ?? '').slice(0, 120)}`);
      break;
    case 'task.routed':
      body = pc.magenta(`→ ${e.payload.model} (${e.payload.source}: ${e.payload.reason})`);
      break;
    case 'merge.result':
      body = (e.payload.status === 'merged' ? pc.green : pc.red)(`merge ${e.payload.branch}: ${e.payload.status}`);
      break;
    case 'budget.warn':
    case 'budget.stop':
      body = pc.red(JSON.stringify(e.payload));
      break;
    default:
      body = pc.dim(JSON.stringify(e.payload).slice(0, 140));
  }
  console.log(`${pc.dim(t)} ${pc.bold(e.type.padEnd(16))} ${who} ${body}`);
}

// ---------------------------------------------------------------- init

program
  .command('init [path]')
  .description('Register a git repo with cortex and write a repo note into the brain')
  .action(async (p: string | undefined) => {
    const cfg = loadConfig();
    const rc = registerRepo(cfg, p ?? process.cwd());
    await writeRepoNote(cfg, rc.name, rc.path, rc.mainBranch);
    console.log(pc.green(`Registered repo "${rc.name}" at ${rc.path}`));
    console.log(pc.dim(`Brain note: repos/${rc.name}/repo.md`));
  });

// ---------------------------------------------------------------- task

program
  .command('task <title...>')
  .description('Dispatch a task to agents')
  .option('-r, --repo <name>', 'repo name (default: the repo containing the current directory)')
  .option('--model <id>', 'force a specific model id')
  .option('--max-model <tier>', 'cap escalation at tier (cheap|mid|top|max)')
  .option('--yolo', 'full autonomy — never ask for permission, allow everything')
  .option('--careful', 'careful autonomy — read & plan, gate edits/commands')
  .option('--review', 'park finished work for human diff review before merging')
  .option('--no-web', 'do not start the dashboard server')
  .action(
    async (
      titleWords: string[],
      opts: {
        repo?: string;
        model?: string;
        maxModel?: Tier;
        yolo?: boolean;
        careful?: boolean;
        review?: boolean;
        web: boolean;
      },
    ) => {
      const title = titleWords.join(' ');
      const hub = new Hub();
      await hub.init();
      const repo = opts.repo ?? (await resolveRepoForCwd(hub.config));
      if (!repo) {
        console.error(pc.red('No repo: run cortex inside a git repo, or pass -r <name>.'));
        process.exit(1);
      }
      const autonomy = opts.yolo ? 'full' : opts.careful ? 'careful' : undefined;
    let dash: { url: string; owned: boolean } | undefined;
    if (opts.web) {
      dash = await startDashboard(hub);
      console.log(pc.dim(`Dashboard: ${dash.url}`));
    }

    hub.store.on('event', printEvent);
    const task = await hub.dispatchTask(title, repo, {
      model: opts.model,
      maxModel: opts.maxModel,
      autonomy,
      reviewBeforeMerge: opts.review,
    });
    console.log(pc.bold(`Task ${task.id}: "${title}" → ${task.model} [${task.tier}]${autonomy ? ' · ' + autonomy : ''}`));

    await new Promise<void>((resolve) => {
      const check = (e: CortexEvent): void => {
        if (e.taskId !== task.id || e.type !== 'task.status') return;
        const s = e.payload.status;
        if (s === 'done' || s === 'failed' || s === 'killed' || s === 'awaiting-merge' || s === 'needs-review') {
          hub.store.off('event', check);
          resolve();
        }
      };
      hub.store.on('event', check);
    });

    // Drain the merge queue before exiting so finished branches land on main.
    // Stop the background interval first so this loop is the SOLE writer to main —
    // otherwise the timer's processNext() can interleave git checkout/merge on the
    // shared main checkout and corrupt the working tree / misreport conflicts.
    let final = hub.store.getTask(task.id);
    if (final?.status === 'needs-review') {
      const url = dash?.url ?? `http://localhost:${hub.config.dashboardPort}`;
      console.log(pc.yellow(`\nParked for review — open ${url} (Review tab) to approve or request changes.`));
      if (dash?.owned) {
        // This process is the only one serving the review endpoints — stay alive
        // so the human can act on it; ctrl-c cleans up.
        console.log(pc.dim('(serving the dashboard here; press ctrl-c when done)'));
        process.on('SIGINT', () => {
          void hub.shutdown().finally(() => process.exit(0));
        });
        await new Promise<void>(() => {}); // block until ctrl-c
      }
      // Another cortex process owns the server (or --no-web): the review is durable
      // in the store and reachable from that process / the next `cortex dashboard`.
      if (!dash) {
        console.log(pc.dim('Tip: run `cortex dashboard` to review (this run had --no-web).'));
      }
      await hub.shutdown();
      process.exit(0);
    }
    if (final?.status === 'awaiting-merge') {
      hub.mergeQueue.stop();
      while (hub.store.nextQueuedMerge(task.repo)) {
        await hub.mergeQueue.processNext();
      }
      const merges = hub.store.listMergeQueue().filter((m) => m.taskId === task.id);
      if (merges.length && merges.every((m) => m.status === 'merged')) {
        hub.store.setTaskStatus(task.id, 'done');
      }
      final = hub.store.getTask(task.id);
    }
    const cost = hub.store.costForTask(task.id);
    console.log(pc.bold(`\nTask ${final?.status} — cost ${fmtUsd(cost)}`));
    await hub.shutdown();
    process.exit(final?.status === 'failed' ? 1 : 0);
  });

// ---------------------------------------------------------------- status

function renderStatus(hub: Hub): string {
  const s = hub.status();
  const lines: string[] = [];
  lines.push(pc.bold(pc.underline('Tasks')));
  for (const t of s.tasks.slice(0, 15)) {
    const color =
      t.status === 'done' ? pc.green : t.status === 'failed' ? pc.red : t.status === 'running' ? pc.cyan : pc.dim;
    lines.push(`  ${color(t.status.padEnd(14))} ${t.title.slice(0, 50).padEnd(52)} ${pc.dim(t.model)} ${fmtUsd(s.costs.byTask[t.id] ?? 0)}`);
  }
  if (!s.tasks.length) lines.push(pc.dim('  (none)'));
  lines.push('');
  lines.push(pc.bold(pc.underline('Active agents')));
  for (const a of s.agents) {
    lines.push(`  ${pc.cyan(a.name.padEnd(16))} ${a.status.padEnd(9)} ${pc.dim(a.model.padEnd(22))} ${fmtUsd(s.costs.byAgent[a.id] ?? 0)} ${pc.dim(a.branch ?? '')}`);
  }
  if (!s.agents.length) lines.push(pc.dim('  (none)'));
  lines.push('');
  const ratio = s.budget.perDayUsd > 0 ? s.daySpendUsd / s.budget.perDayUsd : 0;
  const budgetColor = ratio >= 1 ? pc.red : ratio >= s.budget.warnRatio ? pc.yellow : pc.green;
  lines.push(`${pc.bold('Day spend')} ${budgetColor(`${fmtUsd(s.daySpendUsd)} / $${s.budget.perDayUsd} (${Math.round(ratio * 100)}%)`)}`);
  lines.push('');
  lines.push(pc.bold(pc.underline('Merge queue')));
  for (const m of s.mergeQueue.slice(0, 10)) {
    const color = m.status === 'merged' ? pc.green : m.status === 'queued' ? pc.dim : m.status === 'conflict' || m.status === 'gate-failed' ? pc.red : pc.yellow;
    lines.push(`  ${color(m.status.padEnd(12))} ${m.branch}`);
  }
  if (!s.mergeQueue.length) lines.push(pc.dim('  (empty)'));
  return lines.join('\n');
}

program
  .command('status')
  .description('Show tasks, agents, costs and merge queue')
  .option('--live', 're-render every 2s')
  .action(async (opts: { live?: boolean }) => {
    const hub = new Hub();
    if (opts.live) {
      const tick = (): void => {
        process.stdout.write('\x1b[2J\x1b[H');
        console.log(renderStatus(hub));
        console.log(pc.dim('\n(ctrl-c to exit)'));
      };
      tick();
      const iv = setInterval(tick, 2000);
      process.on('SIGINT', async () => {
        clearInterval(iv);
        await hub.shutdown();
        process.exit(0);
      });
    } else {
      console.log(renderStatus(hub));
      await hub.shutdown();
    }
  });

// ---------------------------------------------------------------- dashboard

program
  .command('dashboard')
  .description('Start the dashboard server and open the browser')
  .action(async () => {
    const hub = new Hub();
    await hub.init();
    const dash = await startDashboard(hub, true);
    console.log(pc.green(`Dashboard running at ${dash.url}`));
  });

// ---------------------------------------------------------------- memory

program
  .command('memory <action> [args...]')
  .description('search|list|pin|unpin|delete|reindex the brain')
  .action(async (action: string, args: string[]) => {
    const cfg = loadConfig();
    const brain = new Brain(cfg.vaultPath);
    await brain.ensureVault();
    switch (action) {
      case 'search': {
        const hits = (await brain.search(args.join(' '), { k: 10 })) as { note: { relPath: string; title: string }; score: number }[];
        for (const h of hits) console.log(`${pc.cyan(h.score.toFixed(3))} ${pc.bold(h.note.title)} ${pc.dim(h.note.relPath)}`);
        if (!hits.length) console.log(pc.dim('no hits'));
        break;
      }
      case 'list': {
        const notes = (await brain.listNotes()) as { relPath: string; title: string; pinned: boolean }[];
        for (const n of notes) console.log(`${n.pinned ? pc.yellow('📌') : '  '} ${pc.bold(n.title)} ${pc.dim(n.relPath)}`);
        break;
      }
      case 'pin':
      case 'unpin':
        await brain.pinNote(args[0], action === 'pin');
        console.log(pc.green(`${action}ned ${args[0]}`));
        break;
      case 'delete':
        await brain.deleteNote(args[0]);
        console.log(pc.green(`deleted ${args[0]}`));
        break;
      case 'reindex':
        await brain.reindex();
        console.log(pc.green('reindexed'));
        break;
      default:
        console.error(pc.red(`unknown memory action: ${action}`));
        process.exit(1);
    }
  });

// ---------------------------------------------------------------- config

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}
function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

program
  .command('config <action> [key] [value]')
  .description('get/set config values by dot-path, e.g. `config set budget.perDayUsd 50`')
  .action((action: string, key?: string, value?: string) => {
    const cfg = loadConfig();
    if (action === 'get') {
      console.log(JSON.stringify(key ? getPath(cfg, key) : cfg, null, 2));
    } else if (action === 'set' && key !== undefined && value !== undefined) {
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        /* keep string */
      }
      setPath(cfg as unknown as Record<string, unknown>, key, parsed);
      saveConfig(cfg as CortexConfig);
      console.log(pc.green(`${key} = ${JSON.stringify(parsed)}`));
    } else {
      console.error(pc.red('usage: cortex config <get|set> [key] [value]'));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------- agent

program
  .command('agent <action> [agentId]')
  .description('pause|resume|kill <agentId>, or pause-all')
  .action(async (action: string, agentId?: string) => {
    const hub = new Hub();
    if (action === 'pause-all') {
      hub.agents.pauseAll();
      console.log(pc.green('paused all agents'));
    } else if ((action === 'pause' || action === 'resume' || action === 'kill') && agentId) {
      await hub.agents[action](agentId);
      console.log(pc.green(`${action} → ${agentId}`));
    } else {
      console.error(pc.red('usage: cortex agent <pause|resume|kill> <agentId> | agent pause-all'));
      process.exit(1);
    }
    await hub.shutdown();
  });

// ---------------------------------------------------------------- repl (default)

async function repl(): Promise<void> {
  const hub = new Hub();
  await hub.init();
  hub.store.on('event', printEvent);

  // Claude-CLI feel: bind the session to the repo you're standing in,
  // and have the website live from the first keystroke.
  let currentRepo = await resolveRepoForCwd(hub.config);
  const dash = await startDashboard(hub);

  console.log(pc.bold(pc.cyan('cortex')) + pc.dim(' — type a task, or /help'));
  if (currentRepo) console.log(pc.dim(`repo: ${currentRepo}`));
  else console.log(pc.yellow('not inside a registered repo — use /repo <name> or cd into one'));
  console.log(pc.dim(`dashboard: ${dash.url}`));

  const promptStr = (): string => pc.magenta(`cortex${currentRepo ? pc.dim(`(${currentRepo})`) : ''}> `);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: promptStr() });
  rl.prompt();

  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  rl.on('line', async (line) => {
    const input = line.trim();
    try {
      if (!input) {
        // noop
      } else if (input.startsWith('/')) {
        const [cmd, ...rest] = input.slice(1).split(/\s+/);
        switch (cmd) {
          case 'status':
            console.log(renderStatus(hub));
            break;
          case 'memory': {
            const hits = (await hub.brain.search(rest.join(' '), { k: 8 })) as { note: { relPath: string; title: string }; score: number }[];
            for (const h of hits) console.log(`${pc.cyan(h.score.toFixed(3))} ${h.note.title} ${pc.dim(h.note.relPath)}`);
            break;
          }
          case 'agents':
            for (const a of hub.store.listAgents(true)) console.log(`${pc.cyan(a.id)} ${a.name} ${a.status} ${pc.dim(a.model)}`);
            break;
          case 'pause':
          case 'resume':
          case 'kill':
            await hub.agents[cmd](rest[0]);
            console.log(pc.green(`${cmd} → ${rest[0]}`));
            break;
          case 'dashboard': {
            const d = await startDashboard(hub, true);
            console.log(pc.green(`Dashboard: ${d.url}`));
            break;
          }
          case 'repo': {
            const name = rest[0];
            if (name && hub.config.repos[name]) {
              currentRepo = name;
              rl.setPrompt(promptStr());
              console.log(pc.green(`repo → ${name}`));
            } else {
              console.log(pc.dim(`registered: ${Object.keys(hub.config.repos).join(', ') || '(none)'}`));
            }
            break;
          }
          case 'help':
            console.log(pc.dim('/status /memory <q> /agents /repo [name] /pause <id> /resume <id> /kill <id> /dashboard /quit\nplain text = dispatch a task in the current repo'));
            break;
          case 'quit':
          case 'exit':
            await hub.shutdown();
            process.exit(0);
            break;
          default:
            console.log(pc.red(`unknown command /${cmd} — try /help`));
        }
      } else {
        let repo = currentRepo;
        if (!repo) {
          const repos = Object.keys(hub.config.repos);
          if (!repos.length) {
            console.log(pc.red('No repos registered. cd into a git repo or run `cortex init <path>` first.'));
          } else {
            const ans = (await ask(pc.dim(`repo? (${repos.join(', ')}) `))).trim();
            repo = repos.includes(ans) ? ans : repos[0];
            currentRepo = repo;
            rl.setPrompt(promptStr());
          }
        }
        if (repo) {
          const task = await hub.dispatchTask(input, repo);
          console.log(pc.bold(`Task ${task.id} dispatched → ${task.model}`));
        }
      }
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await hub.shutdown();
    process.exit(0);
  });
}

program.action(async () => {
  await repl();
});

program.parseAsync(process.argv);
