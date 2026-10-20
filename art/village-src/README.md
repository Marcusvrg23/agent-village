# Arte de origem da Agent Village

| Arquivo | Origem | Uso |
|---|---|---|
| `village-map-higgsfield.png` | Gerada pelo usuário no Higgsfield (modelo `gpt_image_2_5`, job `72a55987-7f18-4c27-a9ca-ad3553ba77ce`, 16/10/2026), a partir de um prompt de vila original (sem cópia de jogos comerciais). | Fonte do mapa. Os 16 personagens pintados foram removidos por `scripts/village-art/clean_map.py`, porque nenhum personagem pode ficar embutido no fundo. |
| `character-sheet-higgsfield.png` | Gerada pelo usuário no Higgsfield (modelo `gpt_image_2_5`, job `1d552c08-c290-4cd7-947a-2b1b2b94eadd`, 16/10/2026). | Folha de sprites base. `scripts/village-art/build_sprites.py` recorta os 16 quadros, alinha pelos pés, reduz para a escala do mapa, quantiza a paleta e gera as 8 variações de papel por troca de cor (`roles.py`). |

O processamento é determinístico: `sh scripts/village-art/build_all.sh` regera `public/village/assets/` a partir destes dois arquivos.
