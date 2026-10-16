# Cut foreground pieces (e.g. the fountain) out of the cleaned map using the polygons in world.json.
import json, sys
from PIL import Image, ImageDraw
world, map_png, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
w = json.load(open(world)); im = Image.open(map_png).convert('RGBA')
for occ in w['occluders']:
    xs = [p[0] for p in occ['poly']]; ys = [p[1] for p in occ['poly']]
    box = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
    mask = Image.new('L', im.size, 0); ImageDraw.Draw(mask).polygon([tuple(p) for p in occ['poly']], fill=255)
    piece = Image.new('RGBA', im.size, (0, 0, 0, 0)); piece.paste(im, (0, 0), mask)
    piece.crop(box).save(f"{outdir}/occluder-{occ['id']}.png", optimize=True)
    occ['image'] = f"assets/occluder-{occ['id']}.png"; occ['at'] = [box[0], box[1]]
json.dump(w, open(world, 'w'), indent=1)
print('occluders', [o['id'] for o in w['occluders']])
