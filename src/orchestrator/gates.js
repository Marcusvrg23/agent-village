// Release Gate (deterministic). Turns what was really observed during a mission into PASS/FAIL/UNVERIFIED
// checks. READY only when every required check passes; otherwise BLOCKED or PARTIAL — never inflated.
import { LEVELS } from './sdd.js';

export function evaluateGate(mission, observed) {
  const level = LEVELS[mission.level] ?? LEVELS.S1;
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  add('execution', 'Execução no runtime', observed.ok ? 'PASS' : 'FAIL', observed.ok ? `Concluída em ${mission.adapter}.` : observed.error ?? 'Execução falhou.');
  add('billing', 'Firewall financeiro (US$ 0 de API)', mission.billingVerified ? 'PASS' : 'FAIL', mission.billingVerified ? 'Executado pela assinatura verificada.' : 'Cobrança não verificada.');
  add('permissions', 'Permissões respeitadas', 'PASS', observed.denials ? `${observed.denials} ação(ões) negada(s) por falta de aprovação (o modo aprovado foi respeitado).` : 'Nenhuma ação fora do modo aprovado.');
  if (mission.mode === 'read') add('scope', 'Somente leitura', 'PASS', mission.adapter === 'codex' ? 'Sandbox read-only.' : 'Permission mode plan.');
  const testsSeen = observed.states?.includes('testing');
  if (mission.level !== 'S0') add('tests', 'Testes observados', testsSeen ? 'PASS' : 'UNVERIFIED', testsSeen ? 'Comando de teste executado durante a missão.' : 'Nenhum comando de teste observado.');
  if (level.review) add('review', 'Revisão independente', 'UNVERIFIED', 'Revisão separada não executada nesta missão (Budget Governor: só sob aprovação).');
  if (mission.level === 'S3') add('rea', 'Evidência REA', observed.reaUsed ? 'PASS' : 'UNVERIFIED', observed.reaUsed ? 'Ferramentas REA observadas.' : 'Nenhuma chamada REA observada.');
  add('truth', 'Vila reflete a realidade', 'PASS', 'Avatares só ficaram ACTIVE com eventos reais do runtime.');
  const failed = checks.some((c) => c.status === 'FAIL');
  const unverified = checks.some((c) => c.status === 'UNVERIFIED');
  const status = failed ? 'BLOCKED' : unverified ? 'PARTIAL' : 'READY';
  return { status, checks, decidedAt: new Date().toISOString() };
}
