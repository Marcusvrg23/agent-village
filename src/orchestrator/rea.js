// REA (Reverse Engineer Anything, morluto) — availability probe and authorization rules. The village never
// installs or registers REA by itself (setup changes client configuration and needs explicit approval).
import { resolveCommand, runOnce, subscriptionEnv } from './proc.js';
import { CLAUDE_API_VARS, CODEX_API_VARS } from './adapters.js';

export const SETUP_HINT = 'Para habilitar: `npx -y rea-agents@6.5.0 setup --client claude_code --dry-run --json` (revise o plano) e depois aplique com aprovação.';

export async function probeRea({ env = process.env } = {}) {
  const bin = resolveCommand('rea', { env });
  if (!bin) return { status: 'UNAVAILABLE', reason: 'CLI `rea` não encontrada no PATH.', hint: SETUP_HINT };
  const r = await runOnce(bin, ['--version'], { env: subscriptionEnv(env, [...CLAUDE_API_VARS, ...CODEX_API_VARS]), timeoutMs: 10_000 });
  const version = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? null;
  return { status: 'AVAILABLE', version, path: bin.file, reason: 'CLI `rea` encontrada.' };
}

/** A binary target can only be analysed when the operator explicitly authorized it. Pure (tested). */
export function reaAuthorization({ target, authorized }) {
  if (!target) return { ok: true, reason: 'Sem alvo binário.' };
  if (!authorized) return { ok: false, reason: 'Alvo binário sem autorização explícita do operador: análise bloqueada.' };
  return { ok: true, reason: 'Operador declarou ser dono do alvo ou ter permissão para analisá-lo.' };
}
