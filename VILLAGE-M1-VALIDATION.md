# Agent Village — validação do M1 (Gate 1) — 16/10/2026

Base: `114d46e` (Life Mode V1.2). Branch: `feat/agent-village`. Nada foi enviado por push nem publicado.

## O que o M1 entrega

Vila isométrica em pixel art com 8 avatares independentes e vida ociosa local (sem dados reais), servida em `/village/` pelo mesmo `server.js`, aberta com `npm run village`. O Ops Room original (`/`), o watcher, o normalizador, o registry e o SSE não foram alterados, exceto por duas linhas no `serveStatic` (índice de diretório e redirecionamento de `/village` para `/village/`).

## Resultados

| Gate | Resultado | Evidência |
|---|---|---|
| Suíte completa | PASS | `node --test`: 64/64 (os 52 testes anteriores mais 12 novos em `test/village.test.js`). |
| AC02: mapa independente das entidades | PASS | 16 figuras pintadas removidas do mapa; avatares são sprites próprios; a fonte é uma camada de primeiro plano, com ordenação por profundidade. |
| AC03: vida ociosa perceptível | PASS | Gravação de 30 s em Chromium real: os 8 avatares mudaram de posição (8 a 25 posições distintas por avatar, amostradas a 1 Hz), cada um com 3 a 6 atividades (andar, observar, digitar, ler, conversar, descansar). Teste: em 30 s simulados, pelo menos 3 atividades simultâneas, pelo menos 3 avatares andando 60 px ou mais, pelo menos 1 saindo do prédio e voltando, ciclo completo de 4 quadros de caminhada, sem sair dos caminhos (desvio < 0,5 px) e sem saltos. |
| Sem fantasmas nem corpos duplicados | PASS | Quadros consecutivos com zoom de 4×: um corpo só, pernas alternando, sombra de contato. |
| AC04: 0 LLM na vida ociosa | PASS | Varredura estática dos módulos (sem URLs absolutas, APIs de modelo, EventSource, WebSocket ou XHR; `fetch` só de `world.json` e `assets/`). Navegador: 19 requisições no carregamento, **0 durante 30 s ociosos**, 0 requisições externas. |
| Console | PASS | 0 erros e 0 avisos (incluindo o favicon). |
| Interação | PASS | Clique no avatar abre o painel do Lead; clique no prédio abre o painel da Forge; pan e zoom funcionam (roda, botões e teclado). |
| Movimento reduzido | PASS | Teste: ninguém anda nem sai do lugar. |
| Preparação do AC06 (tarefa interrompe a rotina) | PASS (unitário) | `assignTask` durante uma caminhada: o avatar termina o trecho atual sem salto, vai ao próprio prédio, fica `WORK`/`verified` sem balões ambiente; `releaseTask` devolve ao STANDBY. **No M1 nenhum evento real chama esse caminho.** |
| Segurança do servidor | PASS | `/village` → 301; `/village/` com o mesmo CSP `default-src 'self'`; travessia codificada (`%2e%2e%2f`) → 403. |

## Limites honestos (o que ainda não está provado)

- **Desempenho no Dell (AC15): PARCIAL.** Na nuvem (Chromium headless), a vila ficou em 30 fps estáveis e cerca de 0,25 ms de renderização por quadro. Isso **não** é medição na Intel HD 4400; falta medir CPU e fps na máquina real.
- **Windows e Electron:** o comando foi testado na nuvem (Linux). A versão `.exe` não foi reempacotada (é o M4).
- **Runtime real (AC05–AC07):** não conectado; o HUD mostra "Runtime: não conectado" e todos os avatares ficam STANDBY.
- **Arte:** a remoção das figuras deixou pequenas emendas em 2 ou 3 pontos de grama, visíveis só com zoom alto. A base direita da fonte foi reconstruída por espelhamento.
- **Orchestrator (S0–S4, Context Vault, Budget Governor, REA):** não iniciado (M3).
