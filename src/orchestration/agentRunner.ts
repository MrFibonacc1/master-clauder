/**
 * Agent child-process entrypoint. Spawned by AgentManager with a JSON config
 * file path as argv[2]. Runs a Claude Agent SDK session in its worktree and
 * streams AgentToHubMsg events as NDJSON on stdout; listens for HubToAgentMsg
 * on stdin.
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentToHubMsg, HubToAgentMsg } from '../shared/types.js';

export interface AgentRunnerConfig {
  agentId: string;
  taskId: string;
  model: string;
  worktreePath: string;
  prompt: string;
  memoryContext: string;
  sdkSessionId?: string;
}

function send(msg: AgentToHubMsg): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '[unserializable]';
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('usage: agentRunner <config.json>');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as AgentRunnerConfig;

  let paused = false;
  let resumeWaiters: (() => void)[] = [];

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg: HubToAgentMsg;
    try {
      msg = JSON.parse(line) as HubToAgentMsg;
    } catch {
      return;
    }
    if (msg.kind === 'kill') {
      send({ kind: 'done', success: false, summary: 'killed by hub' });
      process.exit(0);
    } else if (msg.kind === 'pause') {
      paused = true;
    } else if (msg.kind === 'resume') {
      paused = false;
      for (const w of resumeWaiters) w();
      resumeWaiters = [];
    }
  });

  const whileUnpaused = (): Promise<void> =>
    paused ? new Promise((res) => resumeWaiters.push(res)) : Promise.resolve();

  const prompt = [
    cfg.memoryContext ? `# Relevant memory\n${cfg.memoryContext}` : '',
    `# Task\n${cfg.prompt}`,
    `# Constraints\nYour working directory is an ISOLATED GIT WORKTREE at ${cfg.worktreePath} — this is the only place you may read or write project files. Use relative paths only. NEVER operate on the main repository checkout or any absolute path outside your worktree, even if other paths are mentioned in memory or context notes. Stay strictly within the file paths you own for this task. When your change is complete, commit it in this worktree with a short message (git add -A && git commit). Never push; never touch other branches.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const q = query({
    prompt,
    options: {
      model: cfg.model,
      cwd: cfg.worktreePath,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(cfg.sdkSessionId ? { resume: cfg.sdkSessionId } : {}),
    },
  });

  let summary = '';
  let success = false;

  for await (const message of q) {
    await whileUnpaused();
    if (message.type === 'system' && message.subtype === 'init') {
      send({ kind: 'session', sdkSessionId: message.session_id });
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          send({ kind: 'message', text: block.text });
        } else if (block.type === 'tool_use') {
          send({ kind: 'tool', name: block.name, summary: summarizeInput(block.input) });
        }
      }
    } else if (message.type === 'result') {
      const u = message.usage;
      send({
        kind: 'usage',
        usage: {
          model: cfg.model,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          costUsd: message.total_cost_usd ?? 0,
        },
      });
      success = message.subtype === 'success' && !message.is_error;
      summary = message.subtype === 'success' ? message.result : (message.errors ?? []).join('; ');
    }
  }

  send({ kind: 'done', success, summary });
  process.exit(success ? 0 : 1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    send({ kind: 'done', success: false, summary: `agent error: ${msg}` });
  } catch {
    // stdout gone; nothing to do
  }
  process.exit(1);
});
