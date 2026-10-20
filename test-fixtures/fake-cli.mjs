#!/usr/bin/env node
// Fake `claude` / `codex` CLIs for tests (no network, no model). Behaviour is driven by env vars:
//   FAKE_LOG          file that receives one JSON line per invocation {cli, args, stdin, apiVars}
//   FAKE_CLAUDE_AUTH  claude.ai | oauth_token | api_key | none        (claude auth status)
//   FAKE_CODEX_LOGIN  chatgpt | apikey | none                         (codex login status)
//   FAKE_CODEX_ACCOUNT chatgpt | apiKey | fail                         (app-server account/read)
//   FAKE_RUN          ok | fail | quota | slow                         (claude -p / codex exec)
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const cli = process.env.FAKE_CLI_NAME ?? path.basename(process.argv[1]).replace(/\.(mjs|js|cmd)$/, '');
const args = process.argv.slice(2);
const API_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'];
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function log(extra = {}) {
  if (!process.env.FAKE_LOG) return;
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli, args, apiVars: API_VARS.filter((k) => process.env[k]), ...extra })}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claude() {
  if (args[0] === '--version') { log(); console.log('2.1.300 (Claude Code)'); return 0; }
  if (args[0] === 'auth' && args[1] === 'status') {
    log();
    const m = process.env.FAKE_CLAUDE_AUTH ?? 'claude.ai';
    out({ loggedIn: m !== 'none', authMethod: m, configDirectory: '/tmp/fake' });
    return m === 'none' ? 1 : 0;
  }
  if (args.includes('-p')) {
    const stdin = await readStdin();
    log({ stdin });
    const run = process.env.FAKE_RUN ?? 'ok';
    out({ type: 'system', subtype: 'init', session_id: 'sess-claude-1', model: 'claude-test', apiKeySource: 'none' });
    if (run === 'slow') await sleep(3_000);
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg1', model: 'claude-test', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/src/app.js' } }] } });
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg2', model: 'claude-test', usage: { input_tokens: 20, output_tokens: 15 },
      content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } });
    if (run === 'fail') { out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-claude-1' }); return 1; }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-claude-1', result: 'Feito. Testes passaram.', usage: { input_tokens: 30, cache_read_input_tokens: 90, output_tokens: 20 } });
    return 0;
  }
  log();
  return 2;
}

async function codex() {
  if (args[0] === '--version') { log(); console.log('codex-cli 0.160.0'); return 0; }
  if (args[0] === 'login' && args[1] === 'status') {
    log();
    const m = process.env.FAKE_CODEX_LOGIN ?? 'chatgpt';
    if (m === 'none') { console.error('Not logged in'); return 1; }
    console.error(m === 'chatgpt' ? 'Logged in using ChatGPT' : 'API key configured - sk-****');
    return 0;
  }
  if (args[0] === 'app-server') {
    log();
    let buf = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        if (msg.method === 'initialize') out({ id: msg.id, result: { userAgent: 'fake' } });
        else if (msg.method === 'account/read') {
          const a = process.env.FAKE_CODEX_ACCOUNT ?? 'chatgpt';
          if (a === 'fail') out({ id: msg.id, error: { code: -32600, message: 'unsupported' } });
          else out({ id: msg.id, result: { account: a === 'chatgpt' ? { type: 'chatgpt', email: null, planType: 'plus' } : { type: 'apiKey' }, requiresOpenaiAuth: true } });
        } else if (msg.method === 'account/rateLimits/read') {
          out({ id: msg.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, planType: 'plus' } } });
        } else out({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
      }
    }
    return 0;
  }
  if (args[0] === 'exec') {
    const stdin = await readStdin();
    log({ stdin });
    const run = process.env.FAKE_RUN ?? 'ok';
    out({ type: 'thread.started', thread_id: 'thread-codex-1' });
    out({ type: 'turn.started' });
    if (run === 'slow') await sleep(3_000);
    out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test' } });
    out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 0 } });
    if (run === 'quota') { out({ type: 'turn.failed', error: { message: "You've hit your usage limit." } }); return 1; }
    if (run === 'fail') { out({ type: 'error', message: 'boom' }); return 1; }
    out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'ok' } });
    out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 3 } });
    return 0;
  }
  log();
  return 2;
}

process.exitCode = await (cli === 'claude' ? claude() : codex());
