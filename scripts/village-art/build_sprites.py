import json, sys, colorsys
import numpy as np
from PIL import Image
from scipy import ndimage
SRC, OUTDIR, ROLE = sys.argv[1], sys.argv[2], sys.argv[3]
import cv2
sys.path.insert(0, __import__('os').path.dirname(__file__))
from roles import ROLES
raw = np.asarray(Image.open(SRC).convert('RGB'))
def recolour(rgb, spec):
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL).astype(np.float32)
    H = hsv[..., 0] * 360 / 256; S = hsv[..., 1] / 255; V = hsv[..., 2] / 255
    out = hsv.copy()
    zones = {'hair': (H >= 199) & (H <= 226) & (S > 0.55) & (V > 0.33),
             'jacket': (H >= 155) & (H < 199) & (S > 0.5) & (V > 0.2)}
    for zone, mask in zones.items():
        if spec.get(zone) is None: continue
        hue, smul, vmul = spec[zone]
        out[..., 0][mask] = hue * 256 / 360
        out[..., 1][mask] = np.clip(S[mask] * smul, 0, 1) * 255
        out[..., 2][mask] = np.clip(V[mask] * vmul, 0, 1) * 255
    return cv2.cvtColor(out.astype(np.uint8), cv2.COLOR_HSV2RGB_FULL)
im = recolour(raw, ROLES[ROLE]).astype(np.int32)
bgmask_src = raw.astype(np.int32)
bg = np.array([8, 20, 56])
fg = np.sqrt(((bgmask_src - bg) ** 2).sum(-1)) > 7
# Frame boxes measured on the 1344x752 sheet (row, col) -> name. Rows: walk down-left, walk up-right, idle, actions.
BOX = {
 'walk_dl_0': (400,24,473,148), 'walk_dl_1': (556,24,632,148), 'walk_dl_2': (712,24,786,148), 'walk_dl_3': (867,24,942,148),
 'walk_ur_0': (396,186,469,306), 'walk_ur_1': (553,186,626,306), 'walk_ur_2': (719,186,790,306), 'walk_ur_3': (870,186,942,306),
 'idle_0': (399,348,473,476), 'blink': (555,348,630,476), 'look_back': (714,348,786,476), 'idle_1': (870,348,944,476),
 'type': (379,536,473,666), 'read': (552,536,629,666), 'talk': (700,536,800,666), 'celebrate': (859,532,957,666),
}
SCALE = 0.36
frames = {}
for name, (x0, y0, x1, y1) in BOX.items():
    m = fg[y0:y1, x0:x1]
    lab, n = ndimage.label(ndimage.binary_closing(m, iterations=1))
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 12])
    keep = ndimage.binary_fill_holes(keep) & (m | ndimage.binary_erosion(keep, iterations=2))
    ys, xs = np.nonzero(keep)
    rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
    rgba[..., :3] = im[y0:y1, x0:x1]
    rgba[..., 3] = keep * 255
    # anchor: feet = lowest opaque row; x = centre of the lowest 25% of the body (legs) — stable across walk frames
    foot = ys.max()
    low = ys > foot - (foot - ys.min()) * 0.25
    ax = xs[low].mean()
    frames[name] = (Image.fromarray(rgba), ax, foot)
# downscale with premultiplied alpha, hard alpha threshold (pixel art)
def shrink(img):
    a = np.asarray(img).astype(np.float32) / 255
    pm = a.copy(); pm[..., :3] *= pm[..., 3:4]
    w, h = img.size; nw, nh = max(1, round(w * SCALE)), max(1, round(h * SCALE))
    chans = [np.asarray(Image.fromarray((pm[..., c] * 255).astype(np.uint8)).resize((nw, nh), Image.BOX)).astype(np.float32) / 255 for c in range(4)]
    al = chans[3]; out = np.zeros((nh, nw, 4), np.uint8)
    for c in range(3): out[..., c] = np.clip(np.where(al > 0, chans[c] / np.maximum(al, 1e-6), 0) * 255, 0, 255)
    out[..., 3] = (al > 0.45) * 255
    return out
small = {k: (shrink(img), ax * SCALE, foot * SCALE) for k, (img, ax, foot) in frames.items()}
# shared palette across all frames so every frame uses identical colours
opaque = np.concatenate([f[f[..., 3] > 0][:, :3] for f, _, _ in small.values()])
pal_img = Image.fromarray(opaque.reshape(1, -1, 3).astype(np.uint8)).quantize(colors=28, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
palette = np.array(pal_img.getpalette()[:28 * 3]).reshape(-1, 3)
def quant(rgb):
    d = ((rgb[:, None, :].astype(int) - palette[None]) ** 2).sum(-1)
    return palette[d.argmin(1)]
CW, CH = 40, 50  # atlas cell; anchor at (CW/2, CH-2)
names = list(BOX)
atlas = np.zeros((CH, CW * len(names), 4), np.uint8)
for i, k in enumerate(names):
    f, ax, foot = small[k]
    q = f.copy(); mask = q[..., 3] > 0
    q[mask, :3] = quant(q[mask, :3])
    ox = int(round(i * CW + CW / 2 - ax)); oy = int(round(CH - 2 - foot))
    h, w = q.shape[:2]
    for yy in range(h):
        for xx in range(w):
            if q[yy, xx, 3] and 0 <= oy + yy < CH and i * CW <= ox + xx < (i + 1) * CW:
                atlas[oy + yy, ox + xx] = q[yy, xx]
Image.fromarray(atlas).save(f'{OUTDIR}/{ROLE.lower()}.png')
json.dump({'cell': [CW, CH], 'anchor': [CW // 2, CH - 2], 'frames': names, 'palette': palette.tolist()}, open(f'{OUTDIR}/{ROLE.lower()}.json', 'w'))
print('frames', len(names), 'cell', CW, CH, 'sizes', {k: v[0].shape[:2] for k, v in list(small.items())[:3]})
