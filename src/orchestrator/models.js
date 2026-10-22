// Model names are CLI arguments, never shell fragments or arbitrary config directives.
// Availability is account-dependent: providers make the final decision at invocation.
export const TEAM_ROLES = Object.freeze(['LEAD', 'WORKER']);
export const MODEL_SUGGESTIONS = Object.freeze({
  'claude-code': ['sonnet', 'opus', 'haiku'],
  codex: ['gpt-5.3-codex', 'gpt-5.2-codex'],
});
export function normalizeModel(model) {
  if (model === undefined || model === null || model === '') return null; // provider default
  if (typeof model !== 'string' || model.length > 64 || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(model)) {
    throw Object.assign(new Error('Modelo inválido: use apenas ID simples do modelo (letras, números, ponto, hífen ou sublinhado).'), { status: 400 });
  }
  return model;
}
export function normalizeTeamModels(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Modelos por agente devem ser um objeto.'), { status: 400 });
  }
  if (Object.keys(input).some(k => !TEAM_ROLES.includes(k))) {
    throw Object.assign(new Error('Somente LEAD e WORKER são agentes configuráveis nesta versão.'), { status: 400 });
  }
  return { LEAD: normalizeModel(input.LEAD), WORKER: normalizeModel(input.WORKER) };
}
