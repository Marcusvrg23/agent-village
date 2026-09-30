# Codex Ops Room

Monitor local, somente leitura, das sessões Codex. A Web V1 estende a V0 e preserva a imagem oficial `public/quality-ops-room-reference.webp`.

## Web

Requer Node.js 20+; nenhuma dependência de produção.

```powershell
node server.js
```

Abra http://127.0.0.1:4173. Outra porta: defina `OPS_ROOM_PORT` apenas no processo atual. O bind permanece `127.0.0.1`.

```powershell
node --test
```

## Observabilidade

- A V0 continua selecionando automaticamente o rollout mais ativo e fazendo tail por offset. Na troca de sessão, a V1 lê uma janela inicial limitada para identificar o agente. Não modifica os rollouts.
- O registry usa IDs, metadata, paths canônicos e atividade operacional. Papéis desconhecidos aparecem como Generic Agent; sem evidência de subagentes, as estações são fases do mesmo agente.
- Parent/child admite vários níveis. Vínculos ausentes não são inventados. Clique numa estação ou em AGENTS / USAGE para ver árvore, detalhes, ferramentas e timeline.
- Setas temporárias exigem origem/destino verificados e timestamp recente. `trigger_turn` isolado não revela direção. Balões têm texto determinístico; conteúdo de mensagens e reasoning não é enviado ao frontend pela camada V1.
- Usage é o último contador cumulativo observado, não a soma de eventos. Input, cached input, output e total permanecem N/A quando ausentes; cached input não é somado novamente. Totais da família informam a cobertura parcial. São contadores do rollout, não uma estimativa de cobrança.
- O monitor segue um rollout de cada vez. Os detalhes de outros agentes refletem evidências observadas, não garantem uma visão simultânea completa de todas as sessões. Após 45 segundos sem atividade, um estado ativo é exibido como idle; o último estado observado permanece nos detalhes.
- `maxConcurrentAgents = 3` fica em `src/agent-registry.js`. O limite é informativo: alerta excesso, mas não cria, pausa nem encerra agentes. Política: tarefas pequenas → Lead; exploração → Explorer; implementação → Worker; review → Reviewer; testes → QA.
- DEBUG mantém caminho, offset, contadores e tipos desconhecidos. AGENTS / USAGE mostra IDs pseudonimizados e apenas atividade operacional. Nenhuma API de modelo ou telemetria externa é usada.

## Verificação de gravação real

`node scripts/verify-v1-recording.mjs <caminho-do-rollout>` valida o delta em uma gravação existente, sem escrever nela. É replay de evidência real, não substitui o teste LIVE.

## Base preservada

Baseline: `e3c1f4e`. Os 14 testes originais foram mantidos. Watcher, normalizador e arte da V0 permanecem inalterados.

## Electron Windows

Para desenvolvimento e empacotamento (Node.js 22.12+):

```powershell
npm.cmd ci --cache .tmp/npm-cache
npm.cmd run desktop
npm.cmd run package:windows
```

Abra `release/Codex Ops Room-win32-x64/Codex Ops Room.exe`. Mantenha a pasta inteira junto do executável: é um aplicativo portátil em pasta, não um instalador ou executável único. A distribuição não inclui node_modules, testes ou cópias dos rollouts. A máquina de destino não precisa ter Node instalado.

O Electron é somente shell: inicia o mesmo `server.js` usando o Node embutido e abre o mesmo frontend. Seleciona automaticamente uma porta livre em `127.0.0.1`; a URL aparece no título. Fechar a janela encerra somente o backend pertencente àquela janela. Nenhuma sessão Codex é encerrada.

O renderer usa sandbox, context isolation, Node desabilitado e bloqueio de requisições/navegação externas. O perfil normal pertence somente a Codex Ops Room no diretório de aplicativos do Windows; não usa `.codex` para armazenamento. O modo `--smoke-test` abre uma janela oculta, verifica a imagem, SSE e rollout real e grava o resultado na pasta indicada por `OPS_ROOM_SMOKE_DIR` (ou no temporário do sistema).

Referências de implementação: [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox/), [Electron Packager](https://packages.electronjs.org/packager/v20.0.1/index.html).
