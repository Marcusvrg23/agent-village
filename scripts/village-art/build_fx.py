# Builds public/village/fx.json and public/village/assets/sky-mask.png from the cleaned map.
# Deterministic (seeded). Usage: python3 build_fx.py <map.png> <fx.json out> <sky-mask.png out>
import json, sys
import numpy as np, cv2
from PIL import Image

map_png, fx_out, sky_out = sys.argv[1], sys.argv[2], sys.argv[3]
rng = np.random.default_rng(20261016)
im = np.asarray(Image.open(map_png).convert('RGB'))
hsv = cv2.cvtColor(im, cv2.COLOR_RGB2HSV_FULL).astype(float)
H = hsv[..., 0] * 360 / 256; S = hsv[..., 1] / 255; V = hsv[..., 2] / 255
Hh, Ww = H.shape

# Water: blue pixels inside hand-drawn regions (river, waterfall, lakes) + the fountain basin.
blue = (H >= 185) & (H <= 235) & (S > 0.35) & (V > 0.22)
REGIONS = {
    'riverL': [(0, 470), (120, 515), (250, 595), (420, 648), (600, 690), (600, 752), (0, 752)],
    'riverMid': [(600, 680), (1000, 672), (1010, 752), (600, 752)],
    'riverR': [(1000, 700), (1150, 610), (1255, 480), (1285, 330), (1344, 320), (1344, 752), (1000, 752)],
    'lakeL': [(0, 160), (150, 160), (150, 252), (0, 252)],
    'lakeR': [(1215, 168), (1344, 168), (1344, 272), (1215, 272)],
}
region = np.zeros((Hh, Ww), np.uint8)
for poly in REGIONS.values():
    cv2.fillPoly(region, [np.array(poly, np.int32)], 1)
fountain = np.zeros((Hh, Ww), np.uint8)
cv2.ellipse(fountain, (647, 358), (82, 40), 0, 0, 360, 1, -1)
cv2.fillPoly(fountain, [np.array([[625, 318], [628, 262], [645, 248], [662, 262], [664, 318]], np.int32)], 0)
water = blue & ((region > 0) | (fountain > 0))
ys, xs = np.nonzero(water)
idx = rng.choice(len(xs), size=1400, replace=False)
water_pts = [[int(xs[i]), int(ys[i])] for i in sorted(idx, key=lambda i: (ys[i], xs[i]))]

# Buildings and labels never receive stars or sky tint.
BLOCK = [(270, 15, 400, 45), (595, 30, 700, 60), (875, 52, 940, 80), (1110, 50, 1235, 78),
         (255, 30, 420, 230), (530, 10, 760, 220), (800, 40, 1020, 230), (1110, 60, 1235, 280)]
foliage = (H >= 70) & (H <= 170) & (S > 0.25)

# Sky (incl. mountains and the two lakes): upper band minus foliage and buildings; soft edge.
# Sky colours only: dusk purple/pink, bright orange horizon, blue-purple mountains. Stone (low saturation),
# wood (dark orange), foliage and the blue dome never match; the watchtower is cut out by hand.
skyish = (((H >= 236) & (H <= 360)) | ((H <= 40) & (V > 0.62))) & (S > 0.16) & ~foliage & (V > 0.2)
cand = np.zeros((Hh, Ww), bool)
cand[:200, :] = True
cand &= skyish
TOWER = [(1164, 12), (1197, 18), (1197, 42), (1174, 42), (1174, 70), (1220, 104), (1215, 112), (1213, 165), (1213, 285), (1113, 285), (1119, 165), (1118, 112), (1115, 104), (1164, 70)]
tower = np.zeros((Hh, Ww), np.uint8)
cv2.fillPoly(tower, [np.array(TOWER, np.int32)], 1)
# inside the tower outline keep only the bright dusk sky seen through its open frame (wood is darker)
through = (V > 0.66) & (S > 0.22) & ((H >= 290) | (H <= 40))
cand &= (tower == 0) | through
lakes = np.zeros((Hh, Ww), np.uint8)
for k in ('lakeL', 'lakeR'):
    cv2.fillPoly(lakes, [np.array(REGIONS[k], np.int32)], 1)
cand |= (lakes > 0) & ~foliage & (V > 0.2)
n, lab = cv2.connectedComponents(cand.astype(np.uint8), connectivity=4)
keep = (set(np.unique(lab[0, :])) | set(np.unique(lab[lakes > 0]))) - {0}
sky = np.isin(lab, list(keep)).astype(np.uint8)
sky = cv2.morphologyEx(sky, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
alpha = cv2.GaussianBlur((sky * 255).astype(np.uint8), (3, 3), 0)
Image.merge('LA', (Image.new('L', (Ww, Hh), 255), Image.fromarray(alpha, 'L'))).save(sky_out, optimize=True)  # alpha = sky

# Stars: smooth sky only, away from the bright sun/clouds.
g = cv2.cvtColor(im, cv2.COLOR_RGB2GRAY).astype(float)
smooth = np.abs(cv2.Laplacian(g, cv2.CV_64F, ksize=3)) < 10
star_ok = np.zeros((Hh, Ww), bool); star_ok[:150, :] = True
star_ok &= ~foliage & smooth & (V < 0.75)
for x0, y0, x1, y1 in BLOCK:
    star_ok[y0:y1, x0:x1] = False
sy, sx = np.nonzero(star_ok)
si = rng.choice(len(sx), size=min(70, len(sx)), replace=False)
stars = [[int(sx[i]), int(sy[i])] for i in si]

canopy = (H >= 80) & (H <= 160) & (S > 0.35) & (V > 0.18) & (V < 0.55)
canopy[:120, :] = False
cy, cx = np.nonzero(canopy)
ci = rng.choice(len(cx), size=160, replace=False)
leaves = [[int(cx[i]), int(cy[i])] for i in ci]

flower = (((H >= 280) | (H <= 10)) & (S > 0.35) & (V > 0.6)) | ((S < 0.15) & (V > 0.85))
flower[:200, :] = False; flower[640:, :] = False
fy, fx = np.nonzero(flower)
fi = rng.choice(len(fx), size=min(120, len(fx)), replace=False)
flowers = [[int(fx[i]), int(fy[i])] for i in fi]

fx_data = {
    'waterPoints': water_pts, 'stars': stars, 'leafPoints': leaves, 'flowerPoints': flowers,
    'waterfall': {'x': 1300, 'y': 395, 'w': 40, 'h': 80},
    'fountain': {'x': 645, 'y': 318},
    # Building signs painted on the map: re-lit after the night light map so they stay readable.
    'signs': [[276, 19, 121, 23], [598, 36, 100, 23], [875, 57, 67, 22], [1113, 53, 121, 23], [140, 229, 100, 22],
              [1018, 234, 92, 23], [276, 409, 136, 23], [909, 408, 108, 23], [589, 491, 113, 23]],
    'emitters': [
        {'kind': 'smoke', 'x': 976, 'y': 48, 'building': 'FORGE'},
        {'kind': 'sparks', 'x': 887, 'y': 172, 'building': 'FORGE'},
        {'kind': 'bubbles', 'x': 185, 'y': 276, 'building': 'TEST_LAB'},
        {'kind': 'bubbles', 'x': 148, 'y': 318, 'building': 'TEST_LAB'},
        {'kind': 'mist', 'x': 1318, 'y': 474},
    ],
}
json.dump(fx_data, open(fx_out, 'w'), separators=(',', ':'))
print({k: len(v) for k, v in fx_data.items() if isinstance(v, list)}, 'sky px', int(sky.sum()))
