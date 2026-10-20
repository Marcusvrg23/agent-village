# Agent Village V2.2 — validação — 20/10/2026

Branch `feat/agent-village` em `Marcusvrg23/agent-village`. Sem merge em `main`, sem deploy.

## Escopo

| Item | Entrega |
|---|---|
| Portabilidade | Servidor sem código específico de sistema; testes com CLIs falsas em `.cmd` no Windows e shell no Unix; `Dockerfile` + `docker-compose.yml` (montagens somente leitura, porta só em 127.0.0.1, execução sempre desligada no container); `npm run package:desktop` para Windows, macOS e Linux; CI no GitHub Actions em ubuntu, macOS e Windows (Node 20 e 22) mais build e smoke do Docker. |
| Precisa de você | `src/attention.js` (fila, long-poll, limpeza quando o CLI responde no terminal), rotas de hook com segredo próprio, `scripts/village-hook.mjs` (Claude Code e Codex), `village:setup hooks`, avatar corre ao Gatehouse e levanta a mão, cartões Aprovar/Recusar/Terminal, aviso de "esperando no terminal", som e notificação opcionais. |
| Várias contas | `src/orchestrator/accounts.js`; um adapter por conta; cota, ledger, roteador e Fonte por conta; missões com `CLAUDE_CONFIG_DIR`/`CODEX_HOME` só em contas extras. |
| Celular | `src/lan.js`: segunda porta opcional, código de 8 caracteres com troca e bloqueio, cookie HttpOnly, celular só lê e responde permissões; layout de celular. |
| Acampamentos | `public/village/camps.js`: barraca por projeto real em 6 lotes, montar, acender, apagar, desmontar. |
| Espera de comandos | Transcrições (Bash sem resultado) e missões (`command_execution`, `tool_result`): ampulheta, pipoca, braços cruzados, teias, cochilo, confete ou nuvem. |
| Vida social | Pedra-papel-tesoura com moedas, futebol com bola, pescaria na ponte (seedados, locais). |
| Visuais | `public/village/skins.js` + `ART-POLICY.md`: visual de outro papel, presets, cores, tom de pele, atlas importado validado. |

## Resultados

| Gate | Resultado | Evidência |
|---|---|---|
| Suíte | PASS | `node --test`: 106/106 (14 novos em `test/v22.test.js`). |
| Hook ↔ vila (E2E real em processos) | PASS | Teste e QA: o hook do Claude imprimiu `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` depois do clique; recusa com motivo saiu como `deny` com a mensagem; hook do Codex aprovado pelo celular. Sem segredo: 403. Vila fechada: o hook sai sem imprimir nada. |
| Formato dos hooks | PASS (fonte oficial) | Claude: referência de hooks (decisão `hookSpecificOutput.decision.behavior`, formato exec `command`+`args`, `onFailure`). Codex: esquema `permission-request.command.output` no código do openai/codex (só `behavior` e `message`; `updatedInput`, `updatedPermissions` e `interrupt` nunca são enviados). |
| Várias contas | PASS | E2E: missão fixada na conta `claude-trabalho` rodou com `CLAUDE_CONFIG_DIR` dessa pasta; a conta padrão foi verificada sem a variável. Pasta com cara de Codex nunca vira conta do Claude. |
| Celular | PASS | Sem pareamento 401; código errado 403; certo devolve cookie HttpOnly/SameSite=Strict; o estado do celular não traz caminhos; missões pelo celular 403; Host estranho na porta principal 403. |
| Navegador (Chromium) | PASS | Mão levantada no Gatehouse, cartões, aviso de terminal, pareamento e pedido no celular (390×780), acampamentos, ampulheta com balão, pedra-papel-tesoura, bola, pescaria, editor de visuais (escolha salva e reaplicada após recarregar). 0 erros de console. |
| Desempenho | PASS | CPU 6× mais lenta (headless, 1366×768): 30 fps de dia e 29 fps à noite com chuva. |
| CI nos 3 sistemas | PASS | GitHub Actions, run 39416981842 (commit `d6c1df3`): ubuntu, macOS e Windows com Node 20 e 22, todos verdes. |
| Docker | PASS | Mesmo run: imagem montada com `docker compose up -d --build`; `/api/health`, `/village/`, orçamento US$ 0 e `"control":false` conferidos dentro do container. Localmente: `hook.json` com permissão 600. |

## Limites honestos

- **Nada disso foi testado com o Claude Code e o Codex reais logados na sua conta.** Todo E2E usou CLIs falsas que imitam os formatos oficiais. Primeiro teste real sugerido: `npm run village:setup -- hooks install --yes`, abrir a vila, abrir uma sessão nova do Claude Code e pedir algo que exija permissão.
- O hook do Codex foi conferido contra o código atual do openai/codex; não confirmei que o codex-cli 0.160.0 já carrega `hooks.json`. Se não carregar, os pedidos do Codex continuam só no terminal.
- macOS e Linux passaram no CI (servidores do GitHub), mas o app desktop empacotado ainda não foi aberto num Mac ou Linux de verdade.
- A conexão do celular na rede local é HTTP: use só em rede de confiança.
