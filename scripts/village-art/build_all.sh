#!/usr/bin/env sh
# Regenerates public/village/assets from the Higgsfield source art in art/village-src.
# Requires Python 3 with numpy, pillow, opencv-python and scipy (asset build only; the app itself has no Python dependency).
set -e
cd "$(dirname "$0")/../.."
OUT=public/village/assets
python3 scripts/village-art/clean_map.py art/village-src/village-map-higgsfield.png $OUT/map.png
for r in LEAD EXPLORER RE_ANALYST SPEC_ARCHITECT WORKER REVIEWER QA RELEASE_GATE; do
  python3 scripts/village-art/build_sprites.py art/village-src/character-sheet-higgsfield.png $OUT/sprites $r
done
python3 scripts/village-art/build_occluders.py public/village/world.json $OUT/map.png $OUT
python3 - <<'PY'
import json
d = 'public/village/assets/sprites'
roles = ['LEAD', 'EXPLORER', 'RE_ANALYST', 'SPEC_ARCHITECT', 'WORKER', 'REVIEWER', 'QA', 'RELEASE_GATE']
base = json.load(open(f'{d}/explorer.json'))
json.dump({'cell': base['cell'], 'anchor': base['anchor'], 'frames': base['frames'],
           'roles': {r: f'assets/sprites/{r.lower()}.png' for r in roles}}, open(f'{d}/manifest.json', 'w'), indent=1)
import os
for r in roles: os.remove(f'{d}/{r.lower()}.json')
PY
python3 scripts/village-art/build_fx.py $OUT/map.png public/village/fx.json $OUT/sky-mask.png
