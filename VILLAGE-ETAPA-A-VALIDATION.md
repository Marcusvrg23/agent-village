# Agent Village — Etapa A (cenário vivo) — validação — 16/10/2026

Base: `088de46` (M1). Branch `feat/agent-village`. Sem push, merge ou deploy.

## Escopo entregue

Ciclo dia/noite, iluminação com halos e cintilação, água animada (rio, fonte, cachoeira), efeitos dos prédios (fumaça e faíscas da Forge, bolhas do Test Lab, pulso dos cristais), vegetação e fauna (folhas, vaga-lumes, borboletas) e clima local (limpo, nublado, chuva, neblina). **As animações dos personagens (sprites, quadros, máquina de estados) não foram alteradas**; a Life Engine só ganhou `setEnvironment`, que muda preferências de passeio à noite e na chuva.

## Aprendido com o Habblaud (MIT), sem copiar código nem visual

- Mapa de luz em meia resolução multiplicado sobre a cena e refeito só quando a "chave de luz" muda → aqui, levado além: o fundo inteiro já iluminado fica em cache.
- Pool fixo de partículas em arrays tipados, sem alocação por quadro.
- Curva de céu por horário com transição suave e `?hora=` para depuração.

## Resultados

| Gate | Resultado | Evidência |
|---|---|---|
| Suíte | PASS | `node --test`: 72/72 (64 anteriores + 8 novos em `test/village-ambience.test.js`). |
| Personagens intactos | PASS | Sprites, atlas e `frameFor` sem diff; testes de caminhada, ciclo de 4 quadros e interrupção por tarefa continuam passando. |
| Luz e clima determinísticos | PASS | Testes de curva do dia, agenda de clima semeada, cross-fade limitado, chave de luz estável por 1 h de dia. |
| Verdade visual | PASS | Teste: noite/chuva nunca marcam ninguém como ACTIVE; HUD diz "Clima e hora do dia: simulação local decorativa". |
| 0 rede / 0 modelo | PASS | `ambience.js` e `effects.js` sem fetch/URL/API; console sem erros em 5 cenários. |
| Desempenho (Chromium headless, 1366×768) | PASS | Normal: 30 fps, 0,4–0,9 ms de JS por quadro. Com CPU 6× mais lenta (simulação aproximada do notebook): sem efeitos 30 fps; dia 30; noite 29; neblina 29; chuva 27–29 (alta) e 30 (baixa). Antes da otimização, chuva caía a 11 fps. |
| Movimento reduzido | PASS | Partículas desligadas e brilhos estáticos quando ativo. |

## Limites honestos

- Medição de desempenho **ainda não feita no Dell real** (Intel HD 4400); a simulação de CPU 6× é aproximada e roda sem GPU. Abra `?debug=1` para ver fps e ms por quadro.
- Árvores pintadas no mapa não balançam (exigiria recortar cada árvore); a vegetação "viva" vem de folhas, vaga-lumes e borboletas.
- Um pouco do céu alaranjado ainda aparece entre as vigas da Watchtower de dia.
- Clima e hora são decorativos; dados reais (cotas, tokens, agentes) entram na Etapa B.
