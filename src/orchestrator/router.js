// Budget Governor / automatic runtime router (operator decision 2026-10-16, ROUTING_POLICY.yaml).
// Pure: given a mission, adapter probes, quota views and running missions it returns a decision with its
// reasons. Fail-closed financial firewall: no paid API path, no unknown billing, US$ 0 allowed by default.

export const POLICY = Object.freeze({
  routingMode: 'automatic',
  allowedRuntimeTypes: ['claude-code', 'codex'],
  allowedApiSpendUsd: 0,
  apiPaidExecution: 'deny',
  unknownBillingExecution: 'deny',
  maxParallelAgents: 3,
  duplicateExecution: 'deny',
  idleLlmCalls: 0,
  writePolicy: 'require_operator_approval',
});

const QUOTA_BLOCK = new Set(['EXHAUSTED']);

// Accepts both a bare snapshot ({windows}) and a QuotaStore view ({snapshot:{windows}}).
function maxUsed(quota) {
  const w = Object.values(quota?.windows ?? quota?.snapshot?.windows ?? {});
  return w.length ? Math.max(...w.map((x) => x.usedPercent)) : null;
}

/** Runtime type of a probe ("claude-code" or "codex"); adapters of extra accounts are "<runtime>@<account>". */
export const runtimeOf = (probe) => probe?.runtime ?? String(probe?.id ?? '').split('@')[0];

/** Firewall + capability check for one adapter. Returns {eligible, waiting, reasons[]}. Pure. */
export function checkAdapter(probe, quota, { needsEdit = false } = {}) {
  const reasons = [];
  if (!probe || !probe.installed) return { eligible: false, waiting: false, reasons: [probe?.reasons?.[0] ?? 'Adapter indisponível.'] };
  if (!POLICY.allowedRuntimeTypes.includes(runtimeOf(probe))) return { eligible: false, waiting: false, reasons: ['Runtime fora da política.'] };
  const b = probe.billing ?? {};
  if (b.mode === 'api') return { eligible: false, waiting: false, reasons: [`Firewall financeiro: ${b.reason ?? 'cobrança por API'}. Gasto autorizado: US$ 0.`] };
  if (b.mode !== 'subscription' || !b.verified) return { eligible: false, waiting: false, reasons: [`Firewall financeiro: modo de cobrança não verificado (${b.reason ?? 'desconhecido'}).`] };
  if (!probe.capabilities?.submit_prompt || !probe.capabilities?.stream_events) return { eligible: false, waiting: false, reasons: ['Adapter sem execução com streaming suportada.'] };
  reasons.push(b.reason);
  if (QUOTA_BLOCK.has(quota?.state)) return { eligible: false, waiting: true, reasons: [...reasons, 'Cota do plano esgotada: WAITING_FOR_QUOTA.'] };
  if (quota?.state === 'LOW') reasons.push(`Cota baixa (${maxUsed(quota)}% usada).`);
  if (['UNKNOWN', 'AWAITING_PROVIDER_RESET', 'STALE'].includes(quota?.state ?? 'UNKNOWN')) reasons.push('Cota sem dado atual (não é suposta como cheia).');
  if (needsEdit) reasons.push('Edição pedida: exige aprovação explícita do operador.');
  return { eligible: true, waiting: false, reasons };
}

/**
 * Ranks eligible adapters. Score uses only real signals: remaining reported quota, measured acceptance
 * history (vault outcomes) and the operator's manual override. No invented prices or quality.
 */
export function route({ mission, probes = {}, quotas = {}, running = [], history = {} }) {
  const decision = { missionId: mission.id, policy: { allowedApiSpendUsd: POLICY.allowedApiSpendUsd, maxParallelAgents: POLICY.maxParallelAgents },
    candidates: [], adapter: null, status: 'blocked', reasons: [] };
  if (running.some((m) => m.id === mission.id)) {
    decision.reasons.push('Esta missão já está em execução: execução duplicada negada.');
    return decision;
  }
  if (running.length >= POLICY.maxParallelAgents) {
    decision.status = 'queued';
    decision.reasons.push(`Limite de ${POLICY.maxParallelAgents} agentes simultâneos atingido (total, não por provedor).`);
    return decision;
  }
  // Manual choice: a runtime type (any of its accounts) or one specific account ("codex@trabalho").
  const choice = mission.runtime && mission.runtime !== 'auto' ? mission.runtime : null;
  const wantedId = (id) => !choice || id === choice || runtimeOf({ id }) === choice;
  const ids = [...new Set([...POLICY.allowedRuntimeTypes, ...Object.keys(probes)])].filter((id) => probes[id] || POLICY.allowedRuntimeTypes.includes(id));
  let anyWaiting = false;
  for (const id of ids) {
    const chk = checkAdapter(probes[id], quotas[id], { needsEdit: mission.mode === 'edit' });
    const c = { id, eligible: chk.eligible && wantedId(id), waiting: chk.waiting, reasons: chk.reasons, score: null };
    if (chk.eligible && !wantedId(id)) c.reasons = [...chk.reasons, 'Fora da escolha manual do operador.'];
    if (chk.waiting && wantedId(id)) anyWaiting = true;
    if (c.eligible) {
      const used = maxUsed(quotas[id]);
      const h = history[id] ?? history[runtimeOf({ id })] ?? { accepted: 0, total: 0 };
      const acceptance = h.total >= 3 ? h.accepted / h.total : null;
      c.score = (used === null ? 50 : 100 - used) + (acceptance === null ? 0 : acceptance * 40);
      c.why = [used === null ? 'cota sem dado atual' : `${100 - used}% da janela mais apertada disponível`,
        acceptance === null ? 'sem histórico suficiente (≥3 missões)' : `${Math.round(acceptance * 100)}% de missões aceitas`].join(' · ');
    }
    decision.candidates.push(c);
  }
  const eligible = decision.candidates.filter((c) => c.eligible).sort((a, b) => b.score - a.score || POLICY.allowedRuntimeTypes.indexOf(runtimeOf(a)) - POLICY.allowedRuntimeTypes.indexOf(runtimeOf(b)) || a.id.localeCompare(b.id));
  if (eligible.length) {
    decision.adapter = eligible[0].id;
    decision.status = 'ready';
    decision.reasons.push(`Selecionado: ${eligible[0].id} (${eligible[0].why}).`);
    if (eligible[1]) decision.fallback = eligible[1].id;
  } else if (anyWaiting) {
    decision.status = 'waiting_for_quota';
    decision.reasons.push('Nenhum runtime elegível sem custo extra: aguardando reinício da cota (WAITING_FOR_QUOTA).');
  } else {
    decision.reasons.push('Nenhum runtime elegível: veja os motivos de cada candidato.');
  }
  return decision;
}

/**
 * Safe fallback after a failed run: only to another already-approved, non-API runtime, only when the
 * previous run is settled (process exited) — never two runs of the same mission at once.
 */
export function fallbackAfterFailure({ mission, failed, settled, probes, quotas, running }) {
  if (!settled) return { status: 'blocked', reasons: ['Execução anterior ainda não encerrada: fallback negado (anti-duplicação).'] };
  const others = { ...probes };
  delete others[failed];
  const d = route({ mission: { ...mission, runtime: 'auto' }, probes: others, quotas, running });
  d.reasons.unshift(`Fallback após falha em ${failed}.`);
  return d;
}
