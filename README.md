# Codex Ops Room

Monitor local, somente leitura, das sessões Codex. A Web V1 estende a V0 e preserva a imagem oficial `public/quality-ops-room-reference.webp`.

## Web

Requer Node.js 20+; nenhuma dependência de produção.

Comando único (backend local + watcher de rollouts + UI web, e abre o navegador):

```powershell
npm run ops-room
```

Sem abrir o navegador: `npm run ops-room -- --no-open` (ou `OPS_ROOM_NO_OPEN=1`). Equivalente sem navegador: `node server.js`.

Se o Ops Room já estiver rodando na porta, o comando apenas abre o navegador nele (sem segundo servidor/watcher). Se outro programa ocupar a porta, ele encerra com erro e sugere outra porta, por exemplo `$env:OPS_ROOM_PORT=4174; npm run ops-room`.

Abra http://127.0.0.1:4173. Outra porta: defina `OPS_ROOM_PORT` apenas no processo atual. O bind permanece `127.0.0.1`.

```powershell
node --test
```

## Agent Village (Release Orchestrator V2 — M1)

Vila isométrica em pixel art com agentes independentes, servida pelo mesmo backend local:

```powershell
npm run village
```

Abre http://127.0.0.1:4173/village/ (mesmas regras de porta e de instância única do `npm run ops-room`; o Ops Room original continua em `/`).

- **Mundo:** mapa limpo (`public/village/assets/map.png`), sem personagens pintados no fundo; caminhos, prédios clicáveis e pontos de convivência em `public/village/world.json`. A fonte central é uma camada de primeiro plano, então quem passa atrás dela fica oculto.
- **Personagens:** 8 papéis (Lead, Explorer, RE Analyst, Spec Architect, Worker, Reviewer, QA, Release Gate), cada um com 16 quadros (andar em 4 direções por espelhamento, ocioso, piscar, olhar para trás, digitar, ler, falar, comemorar). Atlas em `public/village/assets/sprites/`.
- **Life Engine** (`public/village/life-engine.js`): simulação local, determinística e semeada. Os avatares passeiam pelos caminhos, visitam prédios, conversam em pares, descansam e voltam ao próprio prédio. Não faz chamadas de modelo, não gasta tokens e não gera eventos técnicos. Os balões são frases ambiente locais, em estilo escuro e tracejado.
- **Verdade visual:** todo avatar começa em **STANDBY**. A ligação com eventos reais do Codex é o M2: o ponto de entrada já existe (`assignTask`/`releaseTask`, que interrompe a rotina, termina o trecho atual sem saltos, leva o avatar ao seu prédio e marca **ACTIVE**), mas no M1 nada o chama.
- **Interação:** arrastar move a câmera; roda do mouse, botões ou teclas `+`, `-` e `0` controlam o zoom; clicar num personagem ou prédio abre o painel lateral; `Esc` fecha. O botão ⏸ e `prefers-reduced-motion` deixam todos parados.
- **Desempenho:** 30 fps no máximo, cenário desenhado como uma única imagem e só 8 sprites por quadro; `?debug=1` mostra fps e ms por quadro.
- **Cenário vivo (Etapa A):** ciclo dia/noite pela hora local (céu azul de dia, pôr do sol, noite estrelada), 65 luzes do mapa (postes, tochas, janelas, forja, cristais, frascos e telas) que acendem à noite com halos e cintilação, água com brilho correndo no rio e na fonte, cachoeira com névoa, fumaça e faíscas na Forge, bolhas no Test Lab, folhas caindo, vaga-lumes à noite, borboletas de dia e clima local (limpo, nublado, chuva, neblina). Botões ⟳/☀/☾ (hora) e ⛅ (clima) no canto superior direito. URL: `?hora=21:30`, `?clima=chuva|neblina|nublado|limpo`, `?qualidade=baixa`, `?efeitos=off`. Clima e hora são simulação decorativa local: nunca representam dados reais nem trabalho de agentes. À noite e na chuva os avatares ficam mais em casa e descansam mais (só preferência de passeio; animações e verdade intactas).
- **Desempenho:** o fundo iluminado é pré-composto num cache refeito só quando a luz muda; os sprites recebem uma versão pré-tingida e a luz local dos postes próximos. Se a taxa ficar abaixo de 24 fps por 3 s, os efeitos passam sozinhos para qualidade baixa.
- **Arte:** gerada com Higgsfield (procedência em `art/village-src/README.md`). Para regerar os assets (mapa, sprites, oclusores, máscara do céu e `fx.json`), rode `sh scripts/village-art/build_all.sh` (requer Python 3 com numpy, pillow, opencv-python e scipy; só o build de arte usa Python, o app não).

## Observabilidade

- A V0 continua selecionando automaticamente o rollout mais ativo e fazendo tail por offset. Na troca de sessão, a V1 lê uma janela inicial limitada para identificar o agente. Não modifica os rollouts.
- O registry usa IDs, metadata, paths canônicos e atividade operacional. Papéis desconhecidos aparecem como Generic Agent; sem evidência de subagentes, as estações são fases do mesmo agente.
- Parent/child admite vários níveis. Vínculos ausentes não são inventados. Clique numa estação ou em AGENTS / USAGE para ver árvore, detalhes, ferramentas e timeline.
- Setas temporárias exigem origem/destino verificados e timestamp recente. `trigger_turn` isolado não revela direção. Balões têm texto determinístico; conteúdo de mensagens e reasoning não é enviado ao frontend pela camada V1.
- Usage é o último contador cumulativo observado, não a soma de eventos. Input, cached input, output e total permanecem N/A quando ausentes; cached input não é somado novamente. Totais da família informam a cobertura parcial. São contadores do rollout, não uma estimativa de cobrança.
- O monitor segue um rollout de cada vez. Os detalhes de outros agentes refletem evidências observadas, não garantem uma visão simultânea completa de todas as sessões. Após 45 segundos sem atividade, um estado ativo é exibido como idle; o último estado observado permanece nos detalhes.
- `maxConcurrentAgents = 3` fica em `src/agent-registry.js`. O limite é informativo: alerta excesso, mas não cria, pausa nem encerra agentes. Política: tarefas pequenas → Lead; exploração → Explorer; implementação → Worker; review → Reviewer; testes → QA.
- DEBUG mantém caminho, offset, contadores e tipos desconhecidos. AGENTS / USAGE mostra IDs pseudonimizados e apenas atividade operacional. Nenhuma API de modelo ou telemetria externa é usada.

## Life Mode (V1.1)

Camada visual só no frontend (`public/life-mode.js`, `life-view.js`, `life.css`), derivada do mesmo snapshot SSE. Nenhuma chamada a modelo, rede extra ou segunda conexão SSE.

- **LIVE IDLE**: sem tarefa real recente. As cinco estações ficam presentes como *standby*, com respiração, cabeça e brilho de monitor sutis, e uma frase ambiente por vez em rotação local determinística ("Ready", "Waiting for tasks", …). Frases ambiente têm balão escuro e não representam atividade do Codex.
- **LIVE TASK**: evento operacional real nos últimos 45 s (mesma janela do registry) ou crescimento do rollout durante a tarefa. Frases ambiente param. Só estações com estado real verificado animam (exploring, working, reviewing, testing, waiting, planning, integrating, done, failed); as demais ficam *standby*. Balões brancos repetem o resumo normalizado do evento; balões de comunicação exigem origem e destino verificados.
- **COMPLETED SNAPSHOT**: `task_complete` (ou erro de sessão) é o evento mais recente. Dura 12 s e volta sozinho para LIVE IDLE; falha de ferramenta não encerra a tarefa. Sem evento de conclusão, a tarefa volta a IDLE após 45 s sem atividade.
- O HUD mostra o modo e "Last activity: Ns ago".

### Personagens vivos (V1.2)

- Cada estação é montada em camadas derivadas da arte oficial (que não é alterada): uma *plate* limpa onde o personagem estava sentado, o personagem recortado (corpo/cabeça), e oclusores à frente (cadeira, placa, objetos da mesa). Assim o personagem pode levantar e sair sem duplicar nem deixar fantasma. Os assets ficam em `public/sprites/` e são regenerados com `npm run build:sprites` (determinístico, só Canvas local; a geometria desenhada à mão está em `scripts/sprite-lib/stations.cjs`, e o build recusa qualquer retoque que copie pixels de um personagem).
- `public/character-mode.js` é uma máquina de estados determinística: IDLE_SIT, BLINK, LOOK_LEFT/RIGHT, HEAD_NOD, TYPE, WORK, STAND_UP, IDLE_STAND, WALK_AWAY, WALK_RETURN, SIT_DOWN, CELEBRATE, ERROR_REACTION.
- Em LIVE IDLE os personagens piscam, olham em volta, digitam e, em turnos (um por vez, a cada ~11 s), levantam, andam um trecho curto perto da própria mesa, dizem uma frase ambiente, voltam e sentam. Em tarefa real, o estado normalizado real comanda a animação; quem estiver andando volta para a mesa antes de trabalhar, e ninguém passeia fora de IDLE.
- Desempenho: as poses são quadros de sprite a 10 fps (estilo jogos isométricos clássicos) aplicados em camadas do compositor; sem movimento, nenhum quadro é desenhado. Medido nesta máquina (GPU Intel HD): ~36% de um núcleo com a sala viva vs ~27% da V1 sem Life Mode.
- `prefers-reduced-motion` mantém todos sentados e parados.

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
