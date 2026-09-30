import path from 'node:path';

export const ROLES = ['EXPLORER', 'WORKER', 'REVIEWER', 'QA', 'LEAD'];

const TEST_PATTERN = /(?:\bpytest\b|\bnode\s+--test\b|\bnpm(?:\.cmd)?\s+(?:run\s+)?test\b|\bpnpm\s+(?:run\s+)?test\b|\byarn\s+test\b|manage\.py\s+test|\beslint\b|\blint\b|\bprettier\b|\bformatter\b|makemigrations\s+--check|deploy\s+check|\btsc\b)/i;
const REVIEW_PATTERN = /(?:\bgit\s+diff\b|\bgit\s+status\b|\breview\b|scope\s+check)/i;
const READ_PATTERN = /(?:\brg\b|ripgrep|grep|Get-Content|Get-ChildItem|Select-String|\bfind\b|\bdir\b|\btype\b|\bcat\b|readFile|readdir|stat\()/i;
const WRITE_PATTERN = /(?:apply_patch|patch_apply|writeFile|appendFile|New-Item|Set-Content|Add-Content|\bmkdir\b|\bnpm(?:\.cmd)?\s+install\b)/i;

function compact(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeBasename(value) {
  const cleaned = String(value ?? '').replace(/["'<>]/g, '').trim();
  if (!cleaned) return null;
  return path.win32.basename(cleaned.replaceAll('/', '\\')).slice(0, 80);
}

function tryJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function extractCommand(input) {
  const parsed = tryJson(input);
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.cmd === 'string') return parsed.cmd;
    if (typeof parsed.command === 'string') return parsed.command;
  }
  if (input && typeof input === 'object') {
    if (typeof input.cmd === 'string') return input.cmd;
    if (typeof input.command === 'string') return input.command;
  }
  if (typeof input !== 'string') return '';

  const match = input.match(/["']cmd["']\s*:\s*"((?:\\.|[^"\\])*)"/s);
  if (!match) return input;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

export function extractWorkdir(input) {
  const parsed = tryJson(input);
  if (parsed && typeof parsed === 'object' && typeof parsed.workdir === 'string') return parsed.workdir;
  if (input && typeof input === 'object' && typeof input.workdir === 'string') return input.workdir;
  if (typeof input !== 'string' || (!input.includes('tools.exec_command') && !input.trim().startsWith('{'))) return null;
  const match = input.match(/["']workdir["']\s*:\s*"((?:\\.|[^"\\])*)"/s);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function fileHint(command) {
  const quoted = [...String(command).matchAll(/["']([^"'\r\n]+?\.(?:[cm]?js|jsx|tsx?|py|json|css|html|md|txt|ya?ml|webp|png|svg))["']/gi)];
  if (quoted.length) return safeBasename(quoted.at(-1)[1]);
  const loose = String(command).match(/([\w.@() -]+\.(?:[cm]?js|jsx|tsx?|py|json|css|html|md|txt|ya?ml|webp|png|svg))\b/i);
  return loose ? safeBasename(loose[1]) : null;
}

function taskName(input) {
  const parsed = tryJson(input);
  if (parsed && typeof parsed === 'object') return compact(parsed.task_name ?? parsed.name ?? parsed.target, 48) || null;
  if (typeof input === 'object' && input) return compact(input.task_name ?? input.name ?? input.target, 48) || null;
  const match = String(input ?? '').match(/["']task_name["']\s*:\s*["']([^"']+)["']/i);
  return match ? compact(match[1], 48) : null;
}

export function classifyToolCall(name, input) {
  const rawName = String(name ?? 'tool');
  const lowerName = rawName.toLowerCase();
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const command = extractCommand(input);
  const combined = `${rawName} ${rawInput} ${command}`;
  const target = fileHint(command || rawInput);

  const directSubagentCall = /(^|[.:/_-])spawn_agent$/i.test(lowerName);
  const directCoordinationCall = /(^|[.:/_-])(send_message|followup_task|wait_agent|list_agents)$/i.test(lowerName);

  if (directSubagentCall) {
    const agent = taskName(input);
    return { role: 'LEAD', summary: agent ? `Delegating to ${agent}` : 'Delegating work', agent, isSubagentEvidence: true };
  }
  if (directCoordinationCall) {
    return { role: 'LEAD', summary: 'Coordinating agents', isSubagentEvidence: true };
  }
  if (/apply_patch|patch_apply/i.test(combined) || WRITE_PATTERN.test(command)) {
    return { role: 'WORKER', summary: target ? `Editing ${target}` : 'Applying code changes' };
  }
  if (TEST_PATTERN.test(command || combined)) {
    return { role: 'QA', summary: target ? `Checking ${target}` : 'Running quality checks' };
  }
  if (REVIEW_PATTERN.test(command || combined)) {
    return { role: 'REVIEWER', summary: /diff/i.test(command) ? 'Inspecting git diff' : 'Checking project scope' };
  }
  if (/view_image/i.test(combined)) {
    return { role: 'EXPLORER', summary: target ? `Inspecting ${target}` : 'Inspecting reference image' };
  }
  if (READ_PATTERN.test(command || combined)) {
    if (/\brg\b|grep|Select-String/i.test(command)) return { role: 'EXPLORER', summary: 'Searching project files' };
    if (/Get-ChildItem|readdir|\bdir\b/i.test(command)) return { role: 'EXPLORER', summary: 'Scanning project structure' };
    return { role: 'EXPLORER', summary: target ? `Reading ${target}` : 'Inspecting project files' };
  }
  if (/write_stdin|wait/i.test(lowerName)) return { role: 'LEAD', summary: 'Waiting for a running task' };
  if (/exec|shell|command/i.test(lowerName)) return { role: 'LEAD', summary: 'Running a local command' };
  return { role: 'UNKNOWN', summary: `Observed tool: ${compact(rawName, 40)}` };
}

function outputText(output) {
  if (typeof output === 'string') return output.slice(0, 20_000);
  try {
    return JSON.stringify(output).slice(0, 20_000);
  } catch {
    return '';
  }
}

function resultSummary(pending, output) {
  const text = outputText(output);
  const fail = text.match(/#\s*fail\s+(\d+)/i) ?? text.match(/\bfail\s+(\d+)\b/i) ?? text.match(/\b(\d+)\s+failed\b/i) ?? text.match(/"exit_code"\s*:\s*([1-9]\d*)/i);
  const pass = text.match(/#\s*pass\s+(\d+)/i) ?? text.match(/\bpass\s+(\d+)\b/i) ?? text.match(/\b(\d+)\s+passed\b/i);
  const fraction = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  const explicitError = /(?:isError["']?\s*:\s*true|Script failed|Process exited with code [1-9]|\bERROR\b)/i.test(text);

  if (fail && Number(fail[1]) > 0 || explicitError) {
    const count = fail && /^\d+$/.test(fail[1]) ? `${fail[1]} failed` : 'Command failed';
    return { state: 'ERROR', summary: pending?.role === 'QA' ? count : `${pending?.summary ?? 'Operation'} failed`, progress: pending?.role === 'QA' ? count : null };
  }
  if (pending?.role === 'QA' && pass) {
    const summary = `${pass[1]} passed`;
    return { state: 'DONE', summary, progress: summary };
  }
  if (pending?.role === 'QA' && fraction) {
    const summary = `${fraction[1]}/${fraction[2]} checks`;
    return { state: 'DONE', summary, progress: summary };
  }
  return { state: 'DONE', summary: pending?.summary ?? 'Operation complete', progress: null };
}

function recordTimestamp(record) {
  const value = record?.timestamp ?? record?.payload?.timestamp ?? record?.payload?.started_at ?? record?.payload?.completed_at;
  const parsed = value ? Date.parse(value) : Number.NaN;
  const milliseconds = record?.payload?.occurred_at_ms ?? record?.payload?.completed_at_ms ?? record?.payload?.started_at_ms;
  if (!Number.isFinite(parsed) && Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function parseJsonLine(line) {
  if (!String(line ?? '').trim()) return { kind: 'empty' };
  try {
    return { kind: 'record', record: JSON.parse(line) };
  } catch {
    return { kind: 'invalid', reason: 'invalid_json' };
  }
}

export class EventNormalizer {
  constructor() {
    this.pendingCalls = new Map();
    this.agents = new Set();
  }

  ingestLine(line) {
    const parsed = parseJsonLine(line);
    if (parsed.kind === 'empty') return { recognized: true, operational: false };
    if (parsed.kind === 'invalid') return { recognized: false, unknown: 'invalid_json_line' };
    return this.ingestRecord(parsed.record);
  }

  ingestRecord(record) {
    const topType = record?.type ?? 'missing';
    const payload = record?.payload ?? {};
    const payloadType = payload?.type ?? 'missing';
    const timestamp = recordTimestamp(record);

    if (topType === 'session_meta') {
      const cwd = payload.cwd ?? null;
      const agentPath = payload.agent_path ?? payload.source?.subagent?.thread_spawn?.agent_path ?? null;
      const nickname = payload.agent_nickname ?? payload.source?.subagent?.thread_spawn?.agent_nickname ?? null;
      const hasAgentEvidence = Boolean(payload.forked_from_id || payload.parent_thread_id || agentPath || nickname);
      if (hasAgentEvidence) this.agents.add(nickname ? `${nickname}${agentPath ? ` — ${agentPath}` : ''}` : agentPath ?? payload.id);
      const result = {
        recognized: true,
        operational: false,
        meta: {
          sessionId: payload.id ?? payload.session_id ?? null,
          cwd,
          project: cwd ? safeBasename(cwd) : null,
        },
      };
      result.mode = this.agents.size ? 'MULTI_AGENT' : 'SINGLE_AGENT';
      result.agents = [...this.agents];
      return result;
    }

    if (topType === 'turn_context') {
      const cwd = payload.cwd ?? null;
      return { recognized: true, operational: false, meta: { cwd, project: cwd ? safeBasename(cwd) : null } };
    }

    if (topType === 'event_msg') {
      if (['token_count', 'thread_settings_applied'].includes(payloadType)) return { recognized: true, operational: false };
      if (payloadType === 'task_started' || payloadType === 'user_message') {
        return this.activity('LEAD', 'ACTIVE', payloadType === 'task_started' ? 'Working' : 'New task received', timestamp, topType, payloadType);
      }
      if (payloadType === 'task_complete') return this.activity('LEAD', 'DONE', 'Turn complete', timestamp, topType, payloadType);
      if (payloadType === 'agent_message') return this.activity('LEAD', 'DONE', 'Response produced', timestamp, topType, payloadType);
      if (payloadType === 'sub_agent_activity') {
        const identity = compact(payload.agent_path ?? payload.agent_thread_id ?? 'subagent', 64);
        this.agents.add(identity);
        const kind = compact(payload.kind ?? 'activity', 32).toLowerCase();
        const state = /complete|finish|done|stop/.test(kind) ? 'DONE' : 'ACTIVE';
        const event = this.activity('LEAD', state, `Subagent ${identity}: ${kind}`, timestamp, topType, payloadType);
        event.mode = 'MULTI_AGENT';
        event.agents = [...this.agents];
        return event;
      }
      if (payloadType === 'item_completed') return { recognized: true, operational: false };
      if (payloadType === 'mcp_tool_call_end') {
        return this.activity(payload.read_only_hint === true ? 'EXPLORER' : 'UNKNOWN', payload.result?.isError ? 'ERROR' : 'DONE', 'MCP tool completed', timestamp, topType, payloadType);
      }
      if (/patch_apply/.test(payloadType)) {
        const files = payload?.changes && typeof payload.changes === 'object' ? Object.keys(payload.changes) : [];
        const target = files.length === 1 ? safeBasename(files[0]) : null;
        const success = payload.success !== false && payload.status !== 'failed';
        return this.activity('WORKER', success ? 'DONE' : 'ERROR', target ? `Updated ${target}` : success ? 'Changes applied' : 'Patch failed', timestamp, topType, payloadType);
      }
      if (/error|failed|abort/i.test(payloadType)) return this.activity('LEAD', 'ERROR', 'Session reported an error', timestamp, topType, payloadType);
      return { recognized: false, unknown: `${topType}:${payloadType}` };
    }

    if (topType === 'response_item') {
      if (payloadType === 'reasoning') return { recognized: true, operational: false, privateContentSuppressed: true };
      if (payloadType === 'message') return { recognized: true, operational: false };
      if (payloadType === 'agent_message') {
        for (const identity of [payload.author, payload.recipient]) {
          if (identity && !['user', 'assistant', 'system', 'developer'].includes(String(identity).toLowerCase())) this.agents.add(compact(identity, 64));
        }
        return { recognized: true, operational: false, privateContentSuppressed: true, mode: 'MULTI_AGENT', agents: [...this.agents] };
      }
      if (payloadType === 'custom_tool_call' || payloadType === 'function_call') {
        const toolInput = payload.arguments ?? payload.input;
        const classification = classifyToolCall(payload.name, toolInput);
        const pending = { ...classification, timestamp, name: payload.name ?? 'tool' };
        if (payload.call_id) this.pendingCalls.set(payload.call_id, pending);
        if (classification.isSubagentEvidence) {
          this.agents.add(classification.agent ?? `observed-agent-${this.agents.size + 1}`);
        }
        const event = this.activity(classification.role, 'ACTIVE', classification.summary, timestamp, topType, payloadType);
        const cwd = String(payload.name ?? '').toLowerCase() === 'exec' ? extractWorkdir(toolInput) : null;
        if (cwd) event.meta = { cwd, project: safeBasename(cwd) };
        event.mode = this.agents.size ? 'MULTI_AGENT' : 'SINGLE_AGENT';
        event.agents = [...this.agents];
        return event;
      }
      if (payloadType === 'custom_tool_call_output' || payloadType === 'function_call_output') {
        const pending = this.pendingCalls.get(payload.call_id);
        if (payload.call_id) this.pendingCalls.delete(payload.call_id);
        if (!pending) return { recognized: true, operational: false };
        const result = resultSummary(pending, payload.output);
        const event = this.activity(pending.role, result.state, result.summary, timestamp, topType, payloadType);
        event.progress = result.progress;
        event.mode = this.agents.size ? 'MULTI_AGENT' : 'SINGLE_AGENT';
        event.agents = [...this.agents];
        return event;
      }
      return { recognized: false, unknown: `${topType}:${payloadType}` };
    }

    if (topType === 'inter_agent_communication_metadata') {
      return { recognized: true, operational: false, mode: 'MULTI_AGENT', agents: [...this.agents] };
    }
    if (['token_usage_record', 'world_state'].includes(topType)) return { recognized: true, operational: false };
    return { recognized: false, unknown: `${topType}:${payloadType}` };
  }

  activity(role, state, summary, timestamp, sourceType, sourceSubtype) {
    return {
      recognized: true,
      operational: true,
      role,
      state,
      summary: compact(summary, 100),
      timestamp,
      sourceType,
      sourceSubtype,
    };
  }
}
