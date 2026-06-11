#!/usr/bin/env node
/**
 * cortex — CLI entry point.
 */
import { spawn } from 'node:child_process';
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
    const brain = new Brain(cfg.vaultPath);
    await brain.ensureVault();
    await brain.writeNote({
      relPath: `repos/${rc.name}/repo.md`,
      title: rc.name,
      scope: 'repo',
      repo: rc.name,
      type: 'convention',
      tags: ['repo'],
      pinned: true,
      created: new Date().toISOString().slice(0, 10),
      body: `Repo **${rc.name}** registered at \`${rc.path}\` (main branch: ${rc.mainBranch ?? 'main'}).`,
      links: [],
    });
    console.log(pc.green(`Registered repo "${rc.name}" at ${rc.path}`));
    console.log(pc.dim(`Brain note: repos/${rc.name}/repo.md`));
  });

// ---------------------------------------------------------------- task

program
  .command('task <title...>')
  .description('Dispatch a task to agents')
  .requiredOption('-r, --repo <name>', 'repo name')
  .option('--model <id>', 'force a specific model id')
  .option('--max-model <tier>', 'cap escalation at tier (cheap|mid|top|max)')
  .action(async (titleWords: string[], opts: { repo: string; model?: string; maxModel?: Tier }) => {
    const title = titleWords.join(' ');
    const hub = new Hub();
    await hub.init();

    hub.store.on('event', printEvent);
    const task = await hub.dispatchTask(title, opts.repo, { model: opts.model, maxModel: opts.maxModel });
    console.log(pc.bold(`Task ${task.id}: "${title}" → ${task.model} [${task.tier}]`));

    await new Promise<void>((resolve) => {
      const check = (e: CortexEvent): void => {
        if (e.taskId !== task.id || e.type !== 'task.status') return;
        const s = e.payload.status;
        if (s === 'done' || s === 'failed' || s === 'killed' || s === 'awaiting-merge') {
          hub.store.off('event', check);
          resolve();
        }
      };
      hub.store.on('event', check);
    });

    const final = hub.store.getTask(task.id);
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
    const port = hub.config.dashboardPort;
    await startServer(hub, port);
    const url = `http://localhost:${port}`;
    console.log(pc.green(`Dashboard running at ${url}`));
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
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
  console.log(pc.bold(pc.cyan('cortex repl')) + pc.dim(' — type a task, or /help'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: pc.magenta('cortex> ') });
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
            const port = hub.config.dashboardPort;
            await startServer(hub, port);
            console.log(pc.green(`Dashboard: http://localhost:${port}`));
            break;
          }
          case 'help':
            console.log(pc.dim('/status /memory <q> /agents /pause <id> /resume <id> /kill <id> /dashboard /quit\nplain text = dispatch a task'));
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
        const repos = Object.keys(hub.config.repos);
        let repo = repos[0];
        if (!repo) {
          console.log(pc.red('No repos registered. Run `cortex init <path>` first.'));
        } else {
          if (repos.length > 1) {
            const ans = (await ask(pc.dim(`repo? (${repos.join(', ')}) `))).trim();
            repo = repos.includes(ans) ? ans : repo;
          }
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
