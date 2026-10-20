# Política de arte da Agent Village

Esta política vale para a arte que vem com a vila e para qualquer visual (skin) que alguém importe pelo botão 🎨.

## Arte que vem com a vila

- O mapa e a folha de personagens foram gerados no Higgsfield pelo dono do projeto, com prompts originais. A procedência está em [`art/village-src/README.md`](art/village-src/README.md).
- Os 8 visuais dos papéis são trocas de cor da mesma folha (`scripts/village-art/roles.py`). O editor 🎨 usa as mesmas regras de cor no navegador.
- Ícones (mão levantada, ampulheta, pipoca, teia, nuvem, moeda, bola, peixe) e as barracas são desenhados por código (`public/village/overlays.js`, `public/village/camps.js`).
- Nenhuma arte de jogos comerciais nem do Habblaud foi copiada. Do Habblaud (licença MIT) foram aproveitadas só ideias de comportamento, sem código nem visual.

## Visuais importados (skins)

Um visual importado fica **só no navegador de quem importou**: não é enviado a servidor nenhum e não aparece para outras pessoas.

Você pode importar um visual se ele atender a **todas** estas condições:

1. **É seu ou você tem permissão.** Arte que você mesmo fez, arte gerada para você, ou arte com uma licença que permite esse uso (por exemplo, CC0 ou CC BY com o crédito informado).
2. **Não usa a identidade de terceiros.** Nada de personagens de filmes, séries, jogos ou quadrinhos, mascotes, logotipos ou marcas, nem pessoas reais (celebridades, colegas ou qualquer pessoa sem consentimento).
3. **Respeita as pessoas.** Nada sexual, nada de ódio ou discriminação, nada de violência explícita, nada que humilhe alguém.
4. **Mantém a verdade da vila.** Um visual muda só a aparência. Não pode imitar os sinais de estado (o anel verde de ACTIVE, a mão levantada, a ampulheta) nem esconder o rótulo do papel.
5. **Informa autor e licença.** O importador exige os dois campos e a confirmação desta política.

## Formato técnico

- PNG com fundo transparente, do mesmo tamanho do atlas original: **640 × 50 px**, 16 quadros de 40 × 50 px numa linha só.
- Ordem dos quadros, da esquerda para a direita: `walk_dl_0..3`, `walk_ur_0..3`, `idle_0`, `blink`, `look_back`, `idle_1`, `type`, `read`, `talk`, `celebrate`.
- Os pés ficam na base do quadro (âncora 20, 48), como no atlas original.
- No máximo 512 KB.

Se um visual violar esta política, remova-o em 🎨 › "Voltar ao visual original".
