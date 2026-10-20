# Agent Village V2.1 — Etapas B–F — validação — 20/10/2026

Branch `feat/agent-village` no repositório `Marcusvrg23/agent-village`. Sem merge em `main`, sem deploy.

## Escopo entregue

| Etapa | Entrega |
|---|---|
| B1 — cotas reais | `src/orchestrator/quota.js`: leitura do Codex (`codex app-server` → `account/rateLimits/read`, sem turno de modelo; ou rollouts locais) e do Claude (coletor do status line). Estados UNKNOWN / FRESH / LOW / EXHAUSTED / AWAITING_PROVIDER_RESET / STALE; janela vencida = sem dado. |
| B2 — ledger + Fonte de Elixir | `ledger.js` (snapshots cumulativos por sessão, sem duplicar) + painel ⛲ e a fonte do mapa: o brilho e as gotas seguem a cota real; faíscas de "recarga" só com `provider.reset_verified`. |
| C — roteamento + firewall | `adapters.js` / `router.js`: assinatura verificada obrigatória, variáveis de API removidas dos processos filhos, US$ 0 de API, máx. 3 agentes, sem duplicar, aguardando cota, um fallback. |
| D — prompt na vila | Painel ✎ Missão: analisar grátis → preflight → aprovar → executar; modo só rascunho por padrão (`VILLAGE_CONTROL=1` para execução real). |
| E — Adaptive SDD, Context Vault, REA | `sdd.js` (S0–S4), `vault.js` (`~/.agent-village/orchestrator`, segredos mascarados), `gates.js` (READY/PARTIAL/BLOCKED), `rea.js` (só alvo autorizado; não instala nada). |
| M2 — agentes reais na vila | `public/village/projector.js`: Codex observado, Claude Code observado e missões da vila viram avatares ACTIVE; um agente real = um avatar. |
| F — app | Electron abre `/village/` (`--ops-room` abre a tela original); smoke test cobre a vila. |

## Resultados

| Gate | Resultado | Evidência |
|---|---|---|
| Suíte | PASS | `node --test`: 92/92 (14 do orquestrador, 6 novos do projetor/fonte, demais anteriores). |
| Firewall financeiro | PASS | Testes E2E com CLIs falsas: `ANTHROPIC_*`/`OPENAI_*`/`CODEX_API_KEY` nunca chegam aos filhos; login por API ou desconhecido bloqueia; `apiKeySource` de chave interrompe a execução. |
| Roteamento pela cota real | PASS (corrigido) | Bug achado no QA: o roteador lia `quota.windows`, mas o orquestrador entrega `{snapshot:{windows}}` → tratava toda cota como "sem dado". Corrigido e coberto por teste; no QA a vila passou a escolher o Codex (60% livre) em vez do Claude (39%). |
| Verdade visual | PASS (corrigido) | Bug achado no QA: um único agente Codex que passava por planejar → explorar → editar → testar ocupava 4 avatares. Agora um agente real ocupa um avatar e libera o anterior; subagentes reais ganham o próprio avatar. |
| Fonte nunca inventa | PASS | Teste: sem dado = "N/D" (nunca 0%); clique só relê; nenhum crédito é alterado. |
| Plano de controle | PASS | Host loopback, mesma origem, JSON, token do processo, corpo ≤ 64 KB (testes). |
| Navegador (Chromium, 1280×760) | PASS | Fluxo completo com CLIs falsas e `VILLAGE_CONTROL=1`: sessão Claude observada → Explorer ACTIVE; fonte com Claude 39% e Codex 60%; preflight S1 com US$ 0; aprovar → Lead/Explorer/Worker/QA em sequência; missão concluída com Gate READY e tokens. 0 erros de console (um erro de CSP de `style` inline foi achado e corrigido). 30 fps. |
| Modo só rascunho | PASS | Sem `VILLAGE_CONTROL`, só "Copiar prompt"; alvo binário sem autorização → bloqueado. |

## O que depende de você (Windows)

1. **Cota do Claude:** `npm run village:setup -- statusline install --yes` (uma vez; faz backup). Sem isso a reserva do Claude fica "N/D".
2. **Execução real:** abrir com `set VILLAGE_CONTROL=1 && npm run village`. Cada missão ainda pede sua aprovação.
3. **Smoke do executável:** `npm.cmd run package:windows` e `"release\Codex Ops Room-win32-x64\Codex Ops Room.exe" --smoke-test`.
4. **REA:** opcional; sem a CLI `rea` no PATH, missões de engenharia reversa seguem só com análise de fonte.

## Limites honestos

- O teste com runtimes reais (Claude Code 2.1.300 e codex-cli 0.160.0 logados na sua conta) **não foi feito aqui**: todo E2E usou CLIs falsas que imitam os formatos oficiais. A primeira missão real deve ser em modo somente leitura.
- O nome do modelo usado em cada missão é o que o próprio runtime escolhe; a vila não o verifica antes de rodar.
- Desempenho no Dell real (Intel HD 4400) ainda não medido; use `?debug=1`.
