// Adaptive Spec-Driven Development: deterministic S0–S4 classification, spec templates and per-role
// context capsules (Context Compiler). No model calls: this runs locally before anything is spent.
import path from 'node:path';

export const LEVELS = Object.freeze({
  S0: { label: 'S0 — trivial', pipeline: ['LEAD'], spec: 'none', review: false, tests: 'focused' },
  S1: { label: 'S1 — pequeno', pipeline: ['LEAD', 'WORKER', 'QA'], spec: 'mini', review: false, tests: 'focused' },
  S2: { label: 'S2 — feature normal', pipeline: ['LEAD', 'SPEC_ARCHITECT', 'EXPLORER', 'WORKER', 'REVIEWER', 'QA', 'RELEASE_GATE'], spec: 'full', review: true, tests: 'focused+broad' },
  S3: { label: 'S3 — complexo / engenharia reversa', pipeline: ['LEAD', 'RE_ANALYST', 'SPEC_ARCHITECT', 'EXPLORER', 'WORKER', 'REVIEWER', 'QA', 'RELEASE_GATE'], spec: 'behavioral', review: true, tests: 'focused+broad+benchmark' },
  S4: { label: 'S4 — crítico', pipeline: ['LEAD', 'SPEC_ARCHITECT', 'EXPLORER', 'WORKER', 'REVIEWER', 'QA', 'RELEASE_GATE'], spec: 'full+risk', review: true, tests: 'full-matrix' },
});

const BINARY_EXT = /\.(exe|dll|so|dylib|asar|apk|ipa|msix|appx|dmg|jar|wasm|elf|bin)\b/i;
const RULES = [
  ['S4', /\b(produ[cç][aã]o|deploy|release|migra[cç][aã]o|pagamento|pix|seguran[cç]a|credenci|vazamento|lgpd|dados sens[ií]veis|rollback)\b/i, 'risco alto (produção/segurança/dados/pagamento)'],
  ['S3', /\b(engenharia reversa|reverse|bin[aá]rio|decompil|clean-?room|multi-?m[oó]dulo|arquitetura|reescrever|refator(ar|a[cç][aã]o) (grande|geral))\b/i, 'complexo ou engenharia reversa'],
  ['S0', /\b(typo|erro de digita[cç][aã]o|ortografia|renomear|coment[aá]rio|texto do bot[aã]o|cor do|espa[cç]amento|bump de vers[aã]o)\b/i, 'mudança trivial e localizada'],
  ['S1', /\b(corrig(ir|e)|bug|ajust(ar|e)|consert(ar|o)|erro|falha)\b/i, 'correção localizada'],
  ['S2', /\b(implement(ar|e)|cri(ar|e)|adicion(ar|e)|nova (tela|feature|funcionalidade|rota|p[aá]gina)|integr(ar|a[cç][aã]o)|endpoint)\b/i, 'feature isolada'],
];

/** Classifies a mission. `target` may be a file path (binary targets imply S3). Pure (tested). */
export function classify({ prompt = '', target = null, mode = 'read' } = {}) {
  const text = String(prompt);
  const reasons = [];
  let level = null;
  if (target && BINARY_EXT.test(target)) { level = 'S3'; reasons.push(`alvo binário/pacote (${path.basename(target)}) → evidência via REA`); }
  for (const [lvl, re, why] of RULES) {
    if (level) break;
    if (re.test(text)) { level = lvl; reasons.push(why); }
  }
  if (!level) { level = text.length < 140 ? 'S1' : 'S2'; reasons.push(text.length < 140 ? 'pedido curto sem sinais de risco' : 'pedido amplo sem sinais de risco'); }
  if (level === 'S0' && text.length > 400) { level = 'S1'; reasons.push('texto longo demais para S0'); }
  if (mode === 'edit' && level === 'S0') reasons.push('edição permitida após aprovação');
  return { level, ...LEVELS[level], reasons, needsRea: level === 'S3' && Boolean(target && BINARY_EXT.test(target)) };
}

export function isBinaryTarget(target) {
  return Boolean(target && BINARY_EXT.test(target));
}

/** Spec skeleton by depth. S0 gets none (no bureaucracy for trivial work). */
export function specTemplate(mission, cls) {
  if (cls.spec === 'none') return null;
  const lines = [`# Spec — ${mission.id}`, '', `**Nível:** ${cls.label}`, `**Objetivo:** ${mission.goal}`, ''];
  lines.push('## Critérios de aceite', '- [ ] Comportamento pedido funciona e é observável', '- [ ] Testes focados passam', '');
  if (cls.spec !== 'mini') lines.push('## Não objetivos', '- Mudanças fora do escopo pedido', '- Refatorações não relacionadas', '');
  if (cls.spec === 'behavioral') lines.push('## Evidência (REA)', '- Evidence Capsule: observado / inferido / desconhecido', '- Spec comportamental clean-room (sem copiar código, assets ou marca)', '', '## Delta de melhoria', '| Área | Observado | Novo design | Por que é melhor | Verificação |', '|---|---|---|---|---|', '');
  if (cls.spec === 'full+risk') lines.push('## Riscos e rollback', '- Plano de rollback antes de qualquer release', '- Revisão de segurança obrigatória', '');
  return lines.join('\n');
}

/**
 * Context Compiler: the single bounded capsule sent with the prompt. It carries the mission, the level,
 * constraints and acceptance — never the whole chat history. The orchestration policy is summarized, not
 * pasted, to keep context minimal.
 */
export function compileCapsule(mission, cls, { rea = null } = {}) {
  const parts = [
    `Missão ${mission.id} (${cls.label}). Objetivo: ${mission.goal}`,
    `Modo: ${mission.mode === 'edit' ? 'pode editar arquivos dentro do projeto' : 'somente leitura — não edite arquivos; entregue análise/plano'}.`,
    'Regras: mudança mínima; não toque em arquivos fora do escopo; não faça commit, push, merge, deploy nem instalações; não exponha segredos.',
  ];
  if (cls.level === 'S0') parts.push('Trivial: faça direto e confirme com uma verificação focada; não escreva spec.');
  if (cls.level === 'S1') parts.push('Pequeno: descreva em 2–3 linhas o que vai mudar, aplique e rode só os testes relacionados.');
  if (['S2', 'S4'].includes(cls.level)) parts.push('Antes de alterar: liste critérios de aceite e não objetivos. Depois: rode testes focados e resuma riscos.');
  if (cls.level === 'S4') parts.push('Crítico: inclua plano de rollback e revisão de segurança; não aplique nada irreversível.');
  if (cls.level === 'S3') {
    parts.push('Complexo: separe evidência (observado/inferido/desconhecido) da spec; implementação original, sem copiar código/arte/marca de terceiros.');
    if (mission.target) parts.push(`Alvo autorizado pelo operador: ${mission.target}.`);
    if (rea?.status === 'AVAILABLE') parts.push('Use as ferramentas REA somente se a fonte não bastar; devolva uma Evidence Capsule curta.');
    else if (cls.needsRea) parts.push('REA indisponível neste computador: trabalhe só com o que a fonte permitir e marque o resto como desconhecido.');
  }
  parts.push('Termine com: o que foi feito, arquivos alterados, testes executados e resultado, riscos e próximos passos.');
  return parts.join('\n');
}
