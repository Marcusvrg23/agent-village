# Exemplar-based inpainting (Criminisi et al. 2004), local search with cv2.matchTemplate.
import sys, json
import numpy as np, cv2
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
# Painted figures located by hand on the 1344x752 Higgsfield map (x0, y0, x1, y1). They are removed so
# that every avatar in the village is an independent sprite (no characters baked into the background).
FIG = [[398,216,428,266],[693,193,724,240],[758,263,788,302],[354,332,387,380],[703,316,772,397],[833,161,870,210],
       [905,166,954,216],[1141,116,1194,154],[1064,343,1096,402],[245,328,278,385],[310,553,345,604],[490,480,520,530],
       [563,622,607,684],[686,622,724,684],[950,546,988,594],[1004,698,1036,750]]
img = cv2.cvtColor(np.asarray(Image.open(src).convert('RGB')), cv2.COLOR_RGB2LAB).astype(np.float32)
H, W, _ = img.shape
hole = np.zeros((H, W), np.uint8)
for x0, y0, x1, y1 in FIG: hole[y0:y1, x0:x1] = 1
P = 4; S = 2*P+1; WIN = 56
conf = (1 - hole).astype(np.float32)
gray = cv2.cvtColor(cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_LAB2RGB), cv2.COLOR_RGB2GRAY).astype(np.float32)
gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0); gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1)
it = 0
while hole.any():
    it += 1
    front = (cv2.dilate(1-hole, np.ones((3,3),np.uint8)) & hole).astype(bool)
    ys, xs = np.nonzero(front)
    # normals of the fill front
    nm = cv2.GaussianBlur(hole.astype(np.float32), (5,5), 0)
    nx = cv2.Sobel(nm, cv2.CV_32F, 1, 0)[ys, xs]; ny = cv2.Sobel(nm, cv2.CV_32F, 0, 1)[ys, xs]
    nn = np.hypot(nx, ny) + 1e-6
    known = (1-hole).astype(np.float32)
    cbox = cv2.boxFilter(conf, -1, (S,S), normalize=True)
    gxm = gx*known; gym = gy*known
    data = np.abs(gym[ys,xs]*nx/nn - gxm[ys,xs]*ny/nn)/255.0 + 0.001
    pr = cbox[ys, xs]*data
    k = int(np.argmax(pr)); py, px = int(ys[k]), int(xs[k])
    py = min(max(py, P), H-P-1); px = min(max(px, P), W-P-1)
    tgt = img[py-P:py+P+1, px-P:px+P+1]
    tmask = (1-hole[py-P:py+P+1, px-P:px+P+1]).astype(np.float32)
    wy0, wy1 = max(0, py-WIN), min(H, py+WIN+1); wx0, wx1 = max(0, px-WIN), min(W, px+WIN+1)
    region = img[wy0:wy1, wx0:wx1]
    m3 = np.repeat(tmask[...,None], 3, 2)
    res = cv2.matchTemplate(region, tgt, cv2.TM_SQDIFF, mask=m3)
    # source patches must be fully known
    valid = cv2.erode((1-hole[wy0:wy1, wx0:wx1]).astype(np.uint8), np.ones((S,S),np.uint8))
    valid = valid[P:P+res.shape[0], P:P+res.shape[1]]
    res[valid == 0] = np.inf
    res[~np.isfinite(res)] = np.inf
    sy, sx = np.unravel_index(int(np.argmin(res)), res.shape)
    srcp = region[sy:sy+S, sx:sx+S]
    sel = tmask == 0
    tgt[sel] = srcp[sel]
    c = cbox[py, px]
    cp = conf[py-P:py+P+1, px-P:px+P+1]; cp[sel] = c
    hole[py-P:py+P+1, px-P:px+P+1] = 0
out_rgb = cv2.cvtColor(img.clip(0,255).astype(np.uint8), cv2.COLOR_LAB2RGB)
# Symmetry repairs: the fountain basin is mirror-symmetric about the crystal axis (x = 646.5). Its right end was
# hidden behind a painted figure, so it is rebuilt from the visible left end (feathered 3 px into the surroundings).
SYMMETRY = [((700, 314, 742, 400), 646.5)]
for (x0, y0, x1, y1), axis in SYMMETRY:
    xs = np.arange(x0, x1)
    src_x = np.round(2 * axis - xs).astype(int)
    patch = out_rgb[y0:y1][:, src_x].astype(np.float32)
    a = np.ones((y1 - y0, x1 - x0), np.float32)
    for k in range(3):
        f = (k + 1) / 4
        a[k, :] = np.minimum(a[k, :], f); a[-1 - k, :] = np.minimum(a[-1 - k, :], f)
        a[:, k] = np.minimum(a[:, k], f); a[:, -1 - k] = np.minimum(a[:, -1 - k], f)
    region = out_rgb[y0:y1, x0:x1].astype(np.float32)
    out_rgb[y0:y1, x0:x1] = (region * (1 - a[..., None]) + patch * a[..., None]).clip(0, 255).astype(np.uint8)
Image.fromarray(out_rgb).save(out); print('iterations', it)
