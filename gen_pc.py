# -*- coding: utf-8 -*-
"""生成演示点云：建筑立面 + SLAM 扫描顺序 + 缺陷真值
输出 data.bin + meta.json
布局: 二进制 [pos Float32 x3N][rgb Uint8 x3N][intensity Uint8 N][sweep Uint8 N]
"""
import json, math, random, struct, os

random.seed(20261118)
W, H = 24.0, 13.0          # 立面 24m x 13m
STEP = 0.04                # 点间距 4cm（≈ 手持 SLAM 中精度档）
NOISE = 0.0015             # 1.5mm 噪声

# 缺陷（同时用于生成几何与 AI 预标注）
DEFECTS = [
    dict(id="C-01", type="裂缝", x=5.2,  y=8.4,  level="Ⅱ", size="长 1.80 m / 宽 2.5 mm", dev=8.2),
    dict(id="C-02", type="裂缝", x=13.6, y=3.1,  level="Ⅲ", size="长 2.40 m / 宽 3.8 mm", dev=12.4),
    dict(id="C-03", type="裂缝", x=20.4, y=10.2, level="Ⅰ", size="长 1.10 m / 宽 1.2 mm", dev=4.1),
    dict(id="K-01", type="空鼓", x=8.0,  y=6.0,  level="Ⅱ", size="面积 0.52 m² / 鼓包 6 mm", dev=6.0),
    dict(id="K-02", type="空鼓", x=16.2, y=9.0,  level="Ⅰ", size="面积 0.38 m² / 鼓包 4 mm", dev=4.0),
    dict(id="S-01", type="渗水", x=11.0, y=1.2,  level="Ⅱ", size="面积 1.20 m² / 色差明显", dev=3.2),
    dict(id="M-01", type="幕墙错位", x=21.0, y=6.5, level="Ⅲ", size="板缝错台 8 mm", dev=8.0),
    dict(id="G-01", type="钢筋外露", x=3.0,  y=2.0, level="Ⅱ", size="面积 0.18 m²", dev=5.5),
]

# 窗洞 (x0,y0,w,h)
WINDOWS = []
for cx in (4.0, 9.0, 14.0, 19.0):
    for cy in (2.6, 6.2, 9.8):
        WINDOWS.append((cx - 1.1, cy - 0.8, 2.2, 1.6))

def clamp(v):
    return int(max(0, min(255, v)))

def in_window(x, y):
    for wx, wy, ww, wh in WINDOWS:
        if wx <= x <= wx + ww and wy <= y <= wy + wh:
            return True
    return False

def sweep_of(x, y):
    """手持设备从 x=0 走到 x=24，按 x 推进分 48 段"""
    s = int(x / W / 48)
    s += random.choice([0, 0, 0, -1]) * (1 if random.random() < 0.3 else 0)
    return max(0, min(47, s))

pts = []  # (x,y,z,r,g,b,inten,sweep)

def push(x, y, z, col, inten):
    r = random.gauss(0, NOISE); z2 = z + r
    pts.append((x, y, z2, col[0], col[1], col[2], inten, sweep_of(x, y)))

# ---- 立面主体 ----
nx, ny = int(W / STEP), int(H / STEP)
for i in range(nx + 1):
    for j in range(ny + 1):
        x = i * STEP + random.uniform(-0.017, 0.017)
        y = j * STEP + random.uniform(-0.017, 0.017)
        if in_window(x, y):
            continue
        z = 0.0
        col = (150, 147, 141)
        inten = 118
        # 混凝土色差 + 污渍
        v = random.gauss(0, 9)
        dirty = math.exp(-((y - 0.2) ** 2) / 1.6) * 22
        col = (clamp(col[0] + v - dirty), clamp(col[1] + v - dirty), clamp(col[2] + v - dirty))
        inten = int(max(40, min(200, 118 + random.gauss(0, 8) - dirty * 0.6)))
        # 空鼓
        for d in DEFECTS:
            if d["type"] == "空鼓":
                dist = math.hypot(x - d["x"], y - d["y"])
                if dist < 0.42:
                    k = math.cos(dist / 0.42 * math.pi / 2)
                    z += 0.006 * k
                    col = (clamp(col[0] + 14), clamp(col[1] + 13), clamp(col[2] + 13))
                    inten = int(max(40, min(220, inten + 16)))
        # 渗水
        for d in DEFECTS:
            if d["type"] == "渗水":
                dist = math.hypot((x - d["x"]) * 0.8, y - d["y"])
                if dist < 0.75:
                    k = 1 - dist / 0.75
                    col = (clamp(col[0] - 34 * k), clamp(col[1] - 28 * k), clamp(col[2] - 20 * k))
                    inten = int(max(30, inten - 26 * k))
        # 幕墙错位：整块板偏移 8mm
        for d in DEFECTS:
            if d["type"] == "幕墙错位":
                if abs(x - d["x"]) < 1.2 and abs(y - d["y"]) < 1.8:
                    z += 0.008
        # 裂缝：沿走向的窄槽
        for d in DEFECTS:
            if d["type"] == "裂缝":
                t = (y - (d["y"] - float(d["size"].split()[1]) / 2)) if False else None
        push(x, y, z, col, inten)

# ---- 裂缝几何：细密点铺在凹槽内 ----
def crack_points(d, dx, dy, length, width_mm):
    n = int(length / 0.006)
    for t in range(n):
        u = t / n
        cx = d["x"] + dx * (u - 0.5) * 2 + math.sin(u * 6) * 0.04
        cy = d["y"] + dy * (u - 0.5) * 2
        for w in (-1.2, -0.6, 0.0, 0.6, 1.2):
            px = cx + w * (width_mm / 1000 * 2) + random.uniform(-0.002, 0.002)
            py = cy + random.uniform(-0.004, 0.004)
            if in_window(px, py):
                continue
            z = -width_mm / 1000 * 0.9
            col = (58, 56, 55)
            pts.append((px, py, z, col[0], col[1], col[2], int(random.uniform(45, 70)), sweep_of(px, py)))
            # 裂缝两侧泛白/剥落
            for s in (-1, 1):
                for off in (0.012, 0.022):
                    px2 = cx + s * (width_mm / 1000 * 3 + off)
                    if not in_window(px2, py):
                        pts.append((px2, py, random.gauss(0, 0.0015), 172, 168, 159, 112, sweep_of(px2, py)))

crack_points(DEFECTS[0], 0.15, 1.0, 1.80, 2.5)
crack_points(DEFECTS[1], -0.35, 1.0, 2.40, 3.8)
crack_points(DEFECTS[2], 0.55, 0.8, 1.10, 1.2)

# ---- 窗：玻璃面 + 窗框 ----
for wx, wy, ww, wh in WINDOWS:
    gx, gy = int(ww / 0.05), int(wh / 0.05)
    for i in range(gx + 1):
        for j in range(gy + 1):
            x = wx + i * 0.05; y = wy + j * 0.05
            edge = (i < 2 or j < 2 or i > gx - 2 or j > gy - 2)
            z = -0.02 if edge else -0.10
            col = (58, 64, 76) if not edge else (86, 86, 88)
            inten = 34 if not edge else 70
            pts.append((x, y, z + random.gauss(0, 0.0012), col[0], col[1], col[2],
                        int(max(20, min(90, inten + random.gauss(0, 6)))), sweep_of(x, y)))

# ---- 地面（SLAM 走过的一条带）----
for i in range(int(W / 0.06) + 1):
    for j in range(int(3.5 / 0.055) + 1):
        x = i * 0.06; y = -0.01; z = j * 0.055
        col = (108, 106, 102)
        pts.append((x + random.uniform(-0.01, 0.01), y + random.uniform(-0.003, 0.003), z,
                    col[0], col[1], col[2], int(max(30, min(150, 96 + random.gauss(0, 10)))), sweep_of(x, y)))

# ---- 钢筋外露（局部颜色异常 + 凸出）----
for _ in range(260):
    a = random.uniform(0, 6.283); r = random.uniform(0, 0.22)
    x = 3.0 + math.cos(a) * r; y = 2.0 + math.sin(a) * r * 0.8
    pts.append((x, y, 0.018 + random.uniform(0, 0.006), 118, 72, 46, 96, sweep_of(x, y)))

# 去重边角超界
pts = [p for p in pts if -0.5 <= p[0] <= W + 0.5 and -0.2 <= p[1] <= H + 0.5]

N = len(pts)
buf = bytearray()
buf += struct.pack("<%df" % (N * 3), *[v for p in pts for v in (p[0], p[1], p[2])])
buf += bytes([v for p in pts for v in (int(p[3]), int(p[4]), int(p[5]))])
buf += bytes([int(p[6]) for p in pts])
buf += bytes([int(p[7]) for p in pts])

out = os.path.join(os.path.dirname(__file__), "data.bin")
open(out, "wb").write(buf)

meta = dict(count=N, width=W, height=H,
            bounds=[0, 0, -0.12, W, H, 0.03],
            sweeps=48, step=STEP,
            trajectory=[[0, 1.55, 2.6], [W, 1.55, 2.6]],
            defects=DEFECTS)
json.dump(meta, open(os.path.join(os.path.dirname(__file__), "meta.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("points", N, "bytes", len(buf))
