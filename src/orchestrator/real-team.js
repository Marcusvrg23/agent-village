// Two independent CLI sessions, a durable audited handoff, and bounded collaboration.
// Not a fake role-play: the bus only records prompts actually submitted and replies returned by the CLIs.
// Team execution is opt-in, requires the original operator approval, and never triggers paid API use.
export const TEAM_ROLES = Object.freeze(['LEAD', 'WORKER']);

export function runRealTeam({ mission, adapter, onEvent = () => {}, onMessage = () => {},
  onAgentChange = () => {}, onTurnResult = () => {} }) {
  const active = new Map();
  const agents = Object.fromEntries(TEAM_ROLES.map((role) => [role, { role, sessionId: null, turns: 0, status: 'queued' }]));
  let cancelled = false;
  const send = (from, to, kind, text, phase) => {
    if (typeof text !== 'string' || !text.trim()) return;
    onMessage({ from, to, kind, text, phase, at: new Date().toISOString() });
  };
  const notify = (role, status) => {
    agents[role].status = status;
    onAgentChange({ ...agents[role] });
  };
  const invoke = async (role, phase, prompt, mode) => {
    if (cancelled) throw new Error('Equipe cancelada.');
    const previous = agents[role].sessionId;
    let handle;
    try {
      handle = adapter.run({
        prompt, cwd: mission.cwd, mode,
        ...(previous ? { resumeSession: previous } : {}),
        name: `village-${mission.id}-${role.toLowerCase()}`,
        onEvent(e) {
          if (e.type === 'session' && e.sessionId) {
            if (previous && e.sessionId !== previous) {
              // Do not misrepresent a newly created session as an actual resumed conversation.
              agents[role].resumeMismatch = true;
            }
            agents[role].sessionId = e.sessionId;
            onAgentChange({ ...agents[role] });
          }
          onEvent({ ...e, role, agentId: `${mission.id}:${role}`, phase });
        },
      });
    } catch (error) {
      notify(role, 'failed');
      throw error;
    }
    active.set(role, handle);
    send('OPERADOR', role, 'instruction', prompt, phase);
    notify(role, 'running');
    let result;
    try {
      result = await handle.done;
    } finally {
      active.delete(role);
    }
    if (cancelled) throw new Error('Equipe cancelada.');
    agents[role].turns++;
    if (result.sessionId) agents[role].sessionId = result.sessionId;
    onTurnResult(role, result);
    const answer = typeof result.resultText === 'string' && result.resultText.trim() ? result.resultText : null;
    if (answer) send(role, 'EQUIPE', 'reply', answer, phase);
    if (!result.ok) {
      notify(role, 'failed');
      throw new Error(`${role} falhou na fase ${phase}: ${result.error ?? 'runtime sem sucesso'}`);
    }
    if (!agents[role].sessionId || (previous && (agents[role].sessionId !== previous || agents[role].resumeMismatch))) {
      notify(role, 'failed');
      throw new Error(`${role} não confirmou continuidade da sessão na fase ${phase}.`);
    }
    if (!answer) {
      notify(role, 'failed');
      throw new Error(`${role} encerrou a fase ${phase} sem entregar uma resposta textual.`);
    }
    notify(role, 'done');
    return answer;
  };

  const done = (async () => {
    try {
      // Both read-only sessions start together. There is never concurrent file editing.
      const [plan, scouting] = await Promise.all([
        invoke('LEAD', 'plan', [
          'Papel da sua sessão: LEAD (Líder e arquiteto).',
          'Esta é uma sessão INDEPENDENTE da sessão WORKER.',
          'Somente leitura. Analise a missão, identifique arquivos e riscos, e entregue um plano verificável.',
          'Não edite arquivos e não inicie subagentes nem crie sessões extras.',
          `Missão: ${mission.prompt}`,
        ].join('\n\n'), 'read'),
        invoke('WORKER', 'scout', [
          'Papel da sua sessão: WORKER (Executor).',
          'Esta é uma sessão INDEPENDENTE da sessão LEAD.',
          'Primeira fase: somente leitura. Explore a base, indique arquivos e testes necessários.',
          'Não edite nesta fase e não inicie subagentes nem crie sessões extras.',
          `Missão: ${mission.prompt}`,
        ].join('\n\n'), 'read'),
      ]);
      if (agents.LEAD.sessionId === agents.WORKER.sessionId) throw new Error('As duas sessões receberam o mesmo ID: colaboração independente não comprovada.');
      send('LEAD', 'WORKER', 'handoff', plan, 'handoff-plan');
      const delivered = await invoke('WORKER', 'execute', [
        'Papel da sua sessão: WORKER (Executor). Continue na MESMA sessão anterior.',
        `Permissão desta fase: ${mission.mode === 'edit' ? 'edição aprovada na pasta do projeto' : 'somente leitura'}.`,
        'Mensagem REAL recebida de LEAD:', plan,
        'Seu levantamento anterior:', scouting,
        'Execute apenas o que o operador aprovou, rode verificações cabíveis e relate arquivos, testes e riscos.',
        `Pedido original: ${mission.prompt}`,
      ].join('\n\n'), mission.mode);
      send('WORKER', 'LEAD', 'handoff', delivered, 'handoff-execute');
      const review = await invoke('LEAD', 'review', [
        'Papel da sua sessão: LEAD (Líder e revisor). Continue na MESMA sessão anterior.',
        'Somente leitura. NÃO edite. Revise independentemente o resultado do WORKER.',
        'Mensagem REAL recebida de WORKER:', delivered,
        'Seu plano anterior:', plan,
        'Verifique evidências, resultados de testes e pendências. Não alegue que testes passaram sem confirmação.',
        `Pedido original: ${mission.prompt}`,
      ].join('\n\n'), 'read');
      return {
        ok: true, sessionId: agents.LEAD.sessionId, usage: null,
        reviewPerformed: true, agents: structuredClone(agents),
        resultText: [
          '# Resultado da equipe real (LEAD + WORKER)',
          '', '## Entrega do WORKER', delivered, '',
          '## Revisão independente do LEAD', review, '',
          '## Sessões verificadas',
          `LEAD: ${agents.LEAD.sessionId} (${agents.LEAD.turns} turnos)`,
          `WORKER: ${agents.WORKER.sessionId} (${agents.WORKER.turns} turnos)`,
        ].join('\n'),
      };
    } catch (error) {
      for (const h of active.values()) h.stop();
      return { ok: false, sessionId: agents.LEAD.sessionId ?? agents.WORKER.sessionId, error: String(error.message),
        usage: null, reviewPerformed: false, agents: structuredClone(agents), resultText: null };
    }
  })();
  return { done, agents, stop() { cancelled = true; for (const h of active.values()) h.stop(); } };
}
