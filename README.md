# Agent Village (e o Codex Ops Room)

Vila local em pixel art onde os seus agentes do **Claude Code** e do **Codex** aparecem trabalhando, levantam a mão quando precisam de você e executam missões aprovadas por você, sem gasto de API. Inclui o Codex Ops Room original (monitor somente leitura das sessões Codex), que preserva a imagem oficial `public/quality-ops-room-reference.webp`.

**Roda em Windows, macOS e Linux** (Node.js 20+, sem dependências de produção), em Docker ou como aplicativo desktop. Testes automáticos nos três sistemas: `.github/workflows/test.yml`.

| Como rodar | Comando | Observação |
|---|---|---|
| Node (qualquer sistema) | `npm run village` | Abre http://127.0.0.1:4173/village/ |
| Docker | `docker compose up -d` | Só observa (execução de missões desligada no container). No Windows, antes: `set VILLAGE_HOST_HOME=%USERPROFILE%` |
| Desktop (Electron) | `npm run desktop` / `npm run package:desktop` | Empacote no próprio sistema de destino; no macOS o app não é assinado (botão direito › Abrir na primeira vez) |

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

## Agent Village (Release Orchestrator V2.1)

Vila isométrica em pixel art com agentes independentes, servida pelo mesmo backend local:

```powershell
npm run village
```

Abre http://127.0.0.1:4173/village/ (mesmas regras de porta e de instância única do `npm run ops-room`; o Ops Room original continua em `/`).

- **Mundo:** mapa limpo (`public/village/assets/map.png`), sem personagens pintados no fundo; caminhos, prédios clicáveis e pontos de convivência em `public/village/world.json`. A fonte central é uma camada de primeiro plano, então quem passa atrás dela fica oculto.
- **Personagens:** 8 papéis (Lead, Explorer, RE Analyst, Spec Architect, Worker, Reviewer, QA, Release Gate), cada um com 16 quadros (andar em 4 direções por espelhamento, ocioso, piscar, olhar para trás, digitar, ler, falar, comemorar). Atlas em `public/village/assets/sprites/`.
- **Life Engine** (`public/village/life-engine.js`): simulação local, determinística e semeada. Os avatares passeiam pelos caminhos, visitam prédios, conversam em pares, descansam e voltam ao próprio prédio. Não faz chamadas de modelo, não gasta tokens e não gera eventos técnicos. Os balões são frases ambiente locais, em estilo escuro e tracejado.
- **Verdade visual:** todo avatar começa em **STANDBY** e só fica **ACTIVE** quando um agente real ocupa o papel (veja *Agentes reais na vila* abaixo). Um agente real ocupa um único avatar por vez; se houver mais agentes no mesmo papel, o painel mostra `(+N)`.
- **Interação:** arrastar move a câmera; roda do mouse, botões ou teclas `+`, `-` e `0` controlam o zoom; clicar num personagem ou prédio abre o painel lateral; `Esc` fecha. O botão ⏸ e `prefers-reduced-motion` deixam todos parados.
- **Desempenho:** 30 fps no máximo, cenário desenhado como uma única imagem e só 8 sprites por quadro; `?debug=1` mostra fps e ms por quadro.
- **Cenário vivo (Etapa A):** ciclo dia/noite pela hora local (céu azul de dia, pôr do sol, noite estrelada), 65 luzes do mapa (postes, tochas, janelas, forja, cristais, frascos e telas) que acendem à noite com halos e cintilação, água com brilho correndo no rio e na fonte, cachoeira com névoa, fumaça e faíscas na Forge, bolhas no Test Lab, folhas caindo, vaga-lumes à noite, borboletas de dia e clima local (limpo, nublado, chuva, neblina). Botões ⟳/☀/☾ (hora) e ⛅ (clima) no canto superior direito. URL: `?hora=21:30`, `?clima=chuva|neblina|nublado|limpo`, `?qualidade=baixa`, `?efeitos=off`. Clima e hora são simulação decorativa local: nunca representam dados reais nem trabalho de agentes. À noite e na chuva os avatares ficam mais em casa e descansam mais (só preferência de passeio; animações e verdade intactas).
- **Desempenho:** o fundo iluminado é pré-composto num cache refeito só quando a luz muda; os sprites recebem uma versão pré-tingida e a luz local dos postes próximos. Se a taxa ficar abaixo de 24 fps por 3 s, os efeitos passam sozinhos para qualidade baixa.
- **Arte:** gerada com Higgsfield (procedência em `art/village-src/README.md`). Para regerar os assets (mapa, sprites, oclusores, máscara do céu e `fx.json`), rode `sh scripts/village-art/build_all.sh` (requer Python 3 com numpy, pillow, opencv-python e scipy; só o build de arte usa Python, o app não).

### V2.1 — cota real, roteamento sem gasto de API e missões na vila

Tudo roda no `server.js` local (127.0.0.1). Nenhuma chamada de modelo acontece sem você aprovar uma missão.

- **Agentes reais na vila (M2):** três fontes, nunca misturadas com a vida ociosa:
  - *Codex (observado)*: os rollouts lidos pelo watcher somente leitura do Ops Room;
  - *Claude Code (observado)*: transcrições em `~/.claude/projects` (só nome da ferramenta e nome do arquivo; nenhum texto de prompt ou resposta);
  - *missão da vila*: missões aprovadas por você no painel ✎ Missão (têm prioridade sobre as observadas).
- **Fonte de Elixir (⛲ ou clique na fonte):** cota real do Claude Pro e do Codex Plus (janela de 5 h e semanal, a mais apertada define o nível), estado (disponível, baixa, esgotada, aguardando dados novos, desatualizada), próxima renovação, origem e idade da leitura, e tokens medidos. *Atualizar leitura* só relê as fontes locais: nunca repõe créditos. Janela vencida vira "sem dado" (nunca 0% ou 100% inventado); a fonte só volta a encher quando o provedor informa a renovação.
  - Codex: `codex app-server` (`account/rateLimits/read`, sem turno de modelo) ou os rollouts locais.
  - Claude: o Claude Code só entrega a cota ao *status line*. Instale o coletor uma vez: `npm run village:setup -- statusline install --yes` (faz backup do `settings.json`, preserva seu status line atual e guarda só as janelas de cota). Remover: `npm run village:setup -- statusline uninstall --yes`.
- **Firewall financeiro (orçamento de API: US$ 0,00):** antes de qualquer execução a vila verifica que o login é pela assinatura (`claude auth status` → `claude.ai`/`oauth_token`; `codex login status` → "Logged in using ChatGPT" + conta `chatgpt`). Cobrança desconhecida ou por API bloqueia. Variáveis de chave de API (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` e afins) são removidas do ambiente dos processos filhos. Nunca usa `--bare`.
- **Roteamento automático:** escolhe entre Claude Code e Codex pela cota real restante (e, depois de 3 missões, pela taxa de aceitação medida); máximo de 3 agentes, sem execução duplicada; cota esgotada → *aguardando cota*; um único fallback seguro. Escolha manual continua sujeita ao firewall.
- **Missões (✎ Missão):** prompt + pasta do projeto + runtime + permissão (somente leitura / pode editar). *Analisar (grátis)* classifica no Adaptive SDD (S0–S4), monta a cápsula de contexto e mostra o preflight (runtime, motivo, risco, "Gasto de API permitido: US$ 0"). *Aprovar e executar* aparece só quando tudo está verificado; editar exige marcar a autorização. Ao final, o Release Gate avalia execução, cobrança, permissões, escopo, testes e verdade visual (READY / PARTIAL / BLOCKED).
  - Por padrão a vila fica em **modo só rascunho** (nada é executado; dá para copiar o prompt). Para permitir execução real: `set VILLAGE_CONTROL=1 && npm run village` (Prompt de Comando) ou `$env:VILLAGE_CONTROL=1; npm run village` (PowerShell).
  - Pastas permitidas: sua pasta pessoal, ou a lista em `VILLAGE_PROJECT_ROOTS` (separadas por `;`).
- **Context Vault:** cada missão grava spec, cápsula, eventos, auditoria e `release.md` em `~/.agent-village/orchestrator` (segredos mascarados); o uso de tokens fica em `~/.agent-village/usage.jsonl`, sem apagar histórico.
- **REA (engenharia reversa):** só para alvo binário que você marcar como seu/autorizado. A vila não instala o REA; se a CLI `rea` não estiver no PATH, a missão segue só com análise de fonte e a evidência binária fica como desconhecida.
- **Segurança do plano de controle:** só aceita Host de loopback, mesma origem, `application/json` e o token do processo; a vila nunca lê `auth.json`, chaveiros ou credenciais.

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

## V2.2 — precisa de você, várias contas, celular, acampamentos, espera, vida social e visuais

**Mão levantada ("precisa de você").** Quando o Claude Code ou o Codex pede uma permissão, o avatar daquela sessão corre até o Gatehouse e levanta a mão; um cartão mostra o que o agente quer fazer (comando, arquivo, página) com **Aprovar**, **Recusar** (com motivo) e **Responder no terminal**. Vale o que você responder primeiro, aqui ou no terminal. Sessões paradas esperando a próxima instrução também aparecem ("esperando você no terminal"). O botão 🔔 liga som e notificação do navegador.
- Instalação (uma vez, com prévia e backup): `npm run village:setup -- hooks install --yes`. No Claude Code entra um hook `PermissionRequest` (e um `Notification` de `idle_prompt`) em `settings.json`, em formato exec (`command` + `args`, sem shell, funciona no Windows sem Git Bash) e com `onFailure: continue`. No Codex entra um hook `PermissionRequest` em `<CODEX_HOME>/hooks.json`; o Codex pede para você confiar nele uma vez em `/hooks`. Remover: `npm run village:setup -- hooks uninstall --yes`.
- Requer Node no computador (o hook é um script Node) e Claude Code 2.1.295 ou mais novo (por causa do `onFailure`). Com a vila fechada ou sem página aberta, o hook sai na hora e tudo segue no terminal. Perguntas do tipo AskUserQuestion aparecem no cartão, mas são respondidas no terminal.
- Segurança: o hook só fala com 127.0.0.1 e se autentica com um segredo gravado em `~/.agent-village/hook.json` (permissão 600), recriado a cada início da vila. Nada aprova sozinho: cada decisão vem de um clique.

**Várias contas.** A vila encontra sozinha cada conta do Claude Code (`~/.claude`, `~/.claude-*` com `projects/`) e do Codex (`~/.codex`, `~/.codex-*`), olhando só se as pastas existem (nunca abre credenciais). A Fonte de Elixir mostra a cota de cada conta, o roteador escolhe a conta com mais cota e, no painel de missão, dá para fixar uma conta. Uma missão de outra conta roda com `CLAUDE_CONFIG_DIR`/`CODEX_HOME` daquela pasta (a conta padrão roda sem mudar nada). Nomes amigáveis: `~/.agent-village/accounts.json`, por exemplo `{"claude-trabalho": {"label": "Trabalho"}}`. Lista: `npm run village:setup -- contas`. Pastas fora do padrão: `VILLAGE_CLAUDE_DIRS` e `VILLAGE_CODEX_HOMES` (separadas por `;`). O status line (cota do Claude) e os hooks são instalados em todas as contas (`--conta <id>` para escolher uma).

**Celular na rede local.** Abra a vila com `VILLAGE_LAN=1` (Windows: `set VILLAGE_LAN=1 && npm run village`). Uma segunda porta (4174 por padrão; `VILLAGE_LAN_PORT`) abre para a rede; a principal continua só em 127.0.0.1. No computador, clique em 📱 para ver o endereço e um código de 8 caracteres; no celular, digite o código uma vez. O código muda a cada 10 minutos e a cada pareamento, e cinco erros seguidos bloqueiam por 10 minutos. O celular só acompanha a vila e responde pedidos de permissão (sem missões, sem configurações, sem caminhos de pasta). "Desconectar celulares" revoga tudo. A conexão na rede local não é criptografada: use só em rede de confiança.

**Acampamento por projeto.** Cada projeto com sessão real (pasta da sessão do Claude Code, missão em execução ou sessão do Codex) ganha uma barraca num dos 6 lotes do mapa. Ela é montada quando o projeto aparece, fica com a luz acesa enquanto há agentes trabalhando, apaga quando param e é desmontada 2 minutos depois da última sessão, liberando o lote. Clique na barraca para ver os detalhes.

**Espera de comandos.** Enquanto um comando real (testes, build, deploy) ainda está rodando, o avatar fica no prédio com uma ampulheta e um balão com o comando e o tempo: come pipoca, depois cruza os braços (3 min), junta teias (10 min) e cochila (25 min). Quando o comando termina, comemora com confete ou ganha uma nuvem de chuva se falhou. Vem das transcrições do Claude Code (chamada `Bash` sem resultado) e dos eventos das missões.

**Vida social.** Avatares sem trabalho real jogam pedra-papel-tesoura apostando moedas, batem bola na praça e pescam na ponte, além de conversar e passear. Tudo é local, semeado e sem IA; as moedas são só diversão e nunca têm relação com tokens ou cota. Um trabalho real interrompe qualquer jogo na hora; com movimento reduzido não há jogos.

**Visuais (🎨).** Troque a aparência de qualquer avatar: o visual de outro papel, presets, cores de cabelo e roupa, tom de pele, ou um atlas importado que siga a [política de arte](ART-POLICY.md) (PNG 640×50 com os mesmos 16 quadros, autor e licença obrigatórios). As animações não mudam. As escolhas ficam só neste navegador.

## Electron (Windows, macOS e Linux)

Para desenvolvimento e empacotamento (Node.js 22.12+):

```powershell
npm.cmd ci --cache .tmp/npm-cache
npm.cmd run desktop
npm.cmd run package:windows
```

No macOS ou no Linux: `npm ci && npm run package:desktop` (empacota para o sistema atual; para outro: `npm run package:desktop -- --platform linux --arch x64`).

Abra `release/Codex Ops Room-win32-x64/Codex Ops Room.exe`. Mantenha a pasta inteira junto do executável: é um aplicativo portátil em pasta, não um instalador ou executável único. A distribuição não inclui node_modules, testes ou cópias dos rollouts. A máquina de destino não precisa ter Node instalado.

O Electron é somente shell: inicia o mesmo `server.js` usando o Node embutido e abre a Agent Village (`/village/`); `--ops-room` abre a tela original. Para execução real de missões no aplicativo, defina `VILLAGE_CONTROL=1` antes de abri-lo. Seleciona automaticamente uma porta livre em `127.0.0.1`; a URL aparece no título. Fechar a janela encerra somente o backend pertencente àquela janela. Nenhuma sessão Codex é encerrada.

O renderer usa sandbox, context isolation, Node desabilitado e bloqueio de requisições/navegação externas. O perfil normal pertence somente a Codex Ops Room no diretório de aplicativos do Windows; não usa `.codex` para armazenamento. O modo `--smoke-test` abre uma janela oculta, verifica a imagem, SSE e rollout real do Ops Room e também a vila (canvas, plano de controle, orçamento US$ 0) e grava o resultado na pasta indicada por `OPS_ROOM_SMOKE_DIR` (ou no temporário do sistema).

Referências de implementação: [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox/), [Electron Packager](https://packages.electronjs.org/packager/v20.0.1/index.html).
