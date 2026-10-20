<p align="center">
  <img src="docs/media/logo.png" width="140" alt="Logo da Agent Village: a fonte de cristal azul da praça da vila, em pixel art" />
</p>

<h1 align="center">Agent Village</h1>

<p align="center">
  <b>A vila onde seus agentes do Claude Code e do Codex trabalham, levantam a mão quando precisam de você e executam missões sem gastar um centavo de API.</b><br />
  Cada agente vira um morador em pixel art; cada projeto ganha uma barraca; a fonte da praça mostra a cota real dos seus planos.
</p>

<p align="center"><b>Português</b> · <a href="README.en.md">English</a> · <a href="https://marcusvrg23.github.io/agent-village/">Site</a></p>

<p align="center">
  <a href="https://github.com/Marcusvrg23/agent-village/actions/workflows/test.yml"><img alt="Testes em Windows, macOS e Linux" src="https://github.com/Marcusvrg23/agent-village/actions/workflows/test.yml/badge.svg?branch=main" /></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-5fa04e?logo=node.js&logoColor=white" />
  <img alt="Windows, macOS e Linux" src="https://img.shields.io/badge/roda%20em-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-4aa8e8" />
  <img alt="Docker pronto" src="https://img.shields.io/badge/Docker-pronto-2496ed?logo=docker&logoColor=white" />
  <img alt="Zero dependências de produção" src="https://img.shields.io/badge/depend%C3%AAncias%20de%20produ%C3%A7%C3%A3o-0-f08a3c" />
  <a href="LICENSE"><img alt="Licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-a77bf3" /></a>
  <img alt="Gasto de API: US$ 0" src="https://img.shields.io/badge/gasto%20de%20API-US%24%200%2C00-5ee6a8" />
</p>

<p align="center">
  <img src="docs/media/vila.gif" width="820" alt="A vila ao entardecer: um agente pede para instalar uma dependência, o avatar dele corre até o Gatehouse e levanta a mão, e o pedido é aprovado no cartão" />
</p>
<p align="center"><sub>Um pedido real de permissão do Claude Code: o avatar corre até o Gatehouse, levanta a mão e você aprova no cartão. Sessões de demonstração.</sub></p>

---

Você abre o Claude Code e o Codex em vários projetos, dispara subagentes, deixa testes rodando… e perde a noção de quem está fazendo o quê, de quem está parado esperando você e de quanto da cota já foi. A **Agent Village** transforma tudo isso numa vila que dá para entender de relance, e vai além de mostrar: **ela também coordena o trabalho**. Você escreve um pedido na vila, ela escolhe entre Claude Code e Codex pela cota real, confere que tudo roda pelo seu plano (nunca por API paga), executa com a sua aprovação e passa o resultado por um Release Gate.

Tudo roda no seu computador. A vila lê os arquivos que o Claude Code e o Codex já gravam, nunca abre credenciais e não faz chamadas externas. A vida dos moradores (passeios, conversas, jogos) é calculada localmente, sem IA e sem gastar tokens.

## O que ela faz

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/mao-levantada.png" alt="Cartão amarelo: Claude Code precisa de você, quer executar npm install date-fns, com os botões Aprovar, Recusar e Responder no terminal" /></td>
    <td width="50%"><img src="docs/media/missao.gif" alt="Uma missão é escrita no painel, analisada de graça, aprovada, e os avatares começam a trabalhar" /></td>
  </tr>
  <tr>
    <td><b>Precisa de você.</b> Quando um agente pede permissão, o avatar daquela sessão corre até o Gatehouse e levanta a mão. O cartão mostra o comando, o arquivo ou a página; você aprova, recusa com um motivo ou deixa para o terminal. Vale o que responder primeiro. Com som e notificação opcionais.</td>
    <td><b>Missões direto da vila.</b> Escreva o pedido, escolha a pasta e se o agente pode editar. A análise é grátis: mostra o nível (S0 a S4), quem vai executar e por quê, o risco e <b>"Gasto de API permitido: US$ 0"</b>. Você aprova e acompanha os avatares; no fim, o Release Gate diz se ficou pronto.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/fonte-elixir.png" alt="Painel Fonte de Elixir com a cota do Claude Code e do Codex: janela de 5 horas, semanal e horário de renovação" /></td>
    <td><img src="docs/media/espera.gif" alt="Avatar no Test Lab com ampulheta e o balão Rodar a suíte de testes, com os minutos passando" /></td>
  </tr>
  <tr>
    <td><b>Fonte de Elixir.</b> A fonte da praça é a cota real dos seus planos: janela de 5 horas e semanal do Claude Pro/Max e do ChatGPT Plus, com a próxima renovação, por conta. Clicar só relê os dados; ela nunca inventa crédito e só volta a encher quando o provedor confirma a renovação.</td>
    <td><b>Esperando o teste rodar.</b> Enquanto um teste ou build de verdade roda, o avatar fica no prédio com uma ampulheta e o tempo: come pipoca, cruza os braços (3 min), junta teias (10 min) e cochila (25 min). Confete se passou, nuvem de chuva se falhou.</td>
  </tr>
  <tr>
    <td><img src="docs/media/vida-social.gif" alt="Avatares batendo bola na praça, jogando pedra-papel-tesoura e pescando na ponte" /></td>
    <td><img src="docs/media/dia-e-noite.gif" alt="Um dia inteiro na vila em segundos: entardecer, noite com lampiões acesos, neblina e amanhecer" /></td>
  </tr>
  <tr>
    <td><b>Vida social.</b> Sem trabalho real, os moradores batem bola na praça, jogam pedra-papel-tesoura valendo moedas e pescam na ponte, cada um com sua personalidade. Um trabalho real interrompe qualquer jogo na hora, e as moedas nunca têm relação com tokens.</td>
    <td><b>Cenário vivo.</b> Dia e noite pela sua hora local, lampiões e janelas que acendem, água correndo, cachoeira, fumaça na Forge, vaga-lumes, chuva e neblina. Roda a 30 fps até num notebook de 2013 com vídeo integrado.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/espera-acampamento.png" alt="Barraca do projeto quality-life ao lado do Context Vault e o avatar do Test Lab com o balão do teste em andamento" /></td>
    <td><img src="docs/screenshots/visuais.png" alt="Painel Visual dos avatares com cabelo dourado, roupa verde, tom de pele e visual Neve aplicados" /></td>
  </tr>
  <tr>
    <td><b>Uma barraca por projeto.</b> Cada projeto com sessão aberta ganha uma barraca num lote do mapa. A luz acende enquanto há agentes trabalhando, apaga quando param, e a barraca é desmontada quando você fecha a última sessão.</td>
    <td><b>Visuais.</b> Troque cabelo, roupa e tom de pele, use o visual de outro papel ou importe uma arte sua seguindo a <a href="ART-POLICY.md">política de arte</a>. As animações continuam as mesmas.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/celular.png" width="260" alt="A vila no celular com um pedido do Codex para executar rm -rf build e os botões Aprovar e Recusar" /></td>
    <td><img src="docs/screenshots/noite-chuva.png" alt="A vila à noite, na chuva, com as janelas e os lampiões acesos" /></td>
  </tr>
  <tr>
    <td><b>No celular.</b> Na mesma rede Wi-Fi, pareie com um código de 8 caracteres e acompanhe a vila, aprovando ou recusando pedidos de longe. O celular não cria missões nem vê caminhos de pasta.</td>
    <td><b>Várias contas.</b> Cada pasta <code>~/.claude*</code> e <code>~/.codex*</code> vira uma conta, com a própria cota. A missão vai para a conta com mais cota livre, ou para a que você escolher.</td>
  </tr>
</table>

## Por que a Agent Village

| | |
|---|---|
| **Coordena, não só mostra** | Missões com análise grátis, escolha automática entre Claude Code e Codex pela cota real, aprovação explícita, Release Gate e histórico no Context Vault. |
| **US$ 0 de API, garantido** | Só executa com login de assinatura verificado; chaves de API são removidas dos processos; cobrança desconhecida bloqueia. Cota esgotada espera a renovação ou vai para outra conta sua. |
| **Windows de primeira classe** | Roda nativo no Windows (hooks em formato exec, sem precisar de Git Bash), além de macOS, Linux, Docker e app desktop. Testado nos três sistemas a cada envio. |
| **Leve** | Zero dependências de produção, um processo Node e Canvas 2D: 30 fps num i5 de 4ª geração com 6 GB de RAM. |
| **Honesta** | Um avatar só fica ACTIVE com um agente real. Clima, hora e vida social são decoração local e dizem isso na tela. |
| **Em português** | Feita no Brasil, com toda a interface em PT-BR. |

## Instalar

Precisa do [Node.js 20+](https://nodejs.org/) e do Claude Code e/ou do Codex logados pelo plano.

```bash
git clone https://github.com/Marcusvrg23/agent-village.git
cd agent-village
npm run village
```

A vila abre em http://127.0.0.1:4173/village/. Depois, uma vez (cada comando mostra uma prévia sem `--yes` e faz backup antes):

```bash
npm run village:setup -- hooks install --yes        # mão levantada (pedidos de permissão na vila)
npm run village:setup -- statusline install --yes   # cota do Claude na Fonte de Elixir
```

A execução de missões já vem ligada: cada missão só roda depois do seu clique em **Aprovar e executar**. Para abrir só em modo rascunho, use `VILLAGE_CONTROL=0` (Windows: `set VILLAGE_CONTROL=0` antes de `npm run village`). Para o celular, `VILLAGE_LAN=1`.

Outras formas de rodar:

| Como rodar | Comando | Observação |
|---|---|---|
| Node (qualquer sistema) | `npm run village` | Abre http://127.0.0.1:4173/village/ |
| Docker | `docker compose up -d` | Só observa (execução de missões desligada no container). No Windows, antes: `set VILLAGE_HOST_HOME=%USERPROFILE%` |
| Desktop (Electron) | `npm run desktop` / `npm run package:desktop` | Empacote no próprio sistema de destino; no macOS o app não é assinado (botão direito › Abrir na primeira vez) |


## Licença

[MIT](LICENSE). A arte da vila segue a [política de arte](ART-POLICY.md).

## Documentação

O repositório também traz o **Codex Ops Room** original (monitor somente leitura das sessões Codex, em `/`), que preserva a imagem oficial `public/quality-ops-room-reference.webp`.

### Web

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
  - A execução real vem **ligada** ao iniciar a vila, e cada missão continua exigindo sua aprovação (e confirmação extra para editar). Para abrir em **modo só rascunho** (nada é executado; dá para copiar o prompt): `VILLAGE_CONTROL=0` (Prompt de Comando: `set VILLAGE_CONTROL=0` e depois `npm run village`). No Docker fica sempre desligada.
  - Pastas permitidas: sua pasta pessoal, ou a lista em `VILLAGE_PROJECT_ROOTS` (separadas por `;`).
- **Context Vault:** cada missão grava spec, cápsula, eventos, auditoria e `release.md` em `~/.agent-village/orchestrator` (segredos mascarados); o uso de tokens fica em `~/.agent-village/ledger/usage.jsonl`, sem apagar histórico.
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

O Electron é somente shell: inicia o mesmo `server.js` usando o Node embutido e abre a Agent Village (`/village/`); `--ops-room` abre a tela original. A execução de missões vem ligada (cada missão pede sua aprovação); `VILLAGE_CONTROL=0` antes de abrir deixa o app em modo rascunho. Seleciona automaticamente uma porta livre em `127.0.0.1`; a URL aparece no título. Fechar a janela encerra somente o backend pertencente àquela janela. Nenhuma sessão Codex é encerrada.

O renderer usa sandbox, context isolation, Node desabilitado e bloqueio de requisições/navegação externas. O perfil normal pertence somente a Codex Ops Room no diretório de aplicativos do Windows; não usa `.codex` para armazenamento. O modo `--smoke-test` abre uma janela oculta, verifica a imagem, SSE e rollout real do Ops Room e também a vila (canvas, plano de controle, orçamento US$ 0) e grava o resultado na pasta indicada por `OPS_ROOM_SMOKE_DIR` (ou no temporário do sistema).

Referências de implementação: [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox/), [Electron Packager](https://packages.electronjs.org/packager/v20.0.1/index.html).
