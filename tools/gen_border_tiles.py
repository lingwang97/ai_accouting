# -*- coding: utf-8 -*-
"""生成小票花边的 24x24 点阵块，写入 miniprogram/utils/bordertiles-data.js
用法：PYTHONUTF8=1 python tools/gen_border_tiles.py
字形取自 Noto Serif SC（OFL，tools/fonts）；回纹 / 云纹 / 菱形 / 素线为程序绘制。
每块 24 行 x 3 字节 = 72 字节，十六进制 144 字符，1 = 黑点。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, 'tools', 'fonts', 'NotoSerifSC-Subset.ttf')
OUT = os.path.join(ROOT, 'miniprogram', 'utils', 'bordertiles-data.js')
N = 24
S = 4  # 超采样倍数


def to_bits(img_big, thr=0.42):
    """大图（N*S）面积平均到 N x N，覆盖率 >= thr 记为黑"""
    small = img_big.resize((N, N), Image.BOX)
    px = small.load()
    return [[1 if (255 - px[x, y]) / 255.0 >= thr else 0 for x in range(N)] for y in range(N)]


def canvas():
    return Image.new('L', (N * S, N * S), 255)


def glyph(ch):
    im = canvas()
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, int(N * S * 0.98))
    box = d.textbbox((0, 0), ch, font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((N * S - w) / 2 - box[0], (N * S - h) / 2 - box[1]), ch, font=f, fill=0, stroke_width=1)
    return to_bits(im)


def hui():
    """回纹：方形螺旋"""
    im = canvas()
    d = ImageDraw.Draw(im)
    pts = [(2, 2), (21, 2), (21, 21), (2, 21), (2, 8), (15, 8), (15, 15), (8, 15), (8, 12)]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        xa, xb = sorted((x0, x1))
        ya, yb = sorted((y0, y1))
        d.rectangle([xa * S, ya * S, (xb + 2) * S - 1, (yb + 2) * S - 1], fill=0)
    return to_bits(im, 0.5)


def dia():
    """空心菱形 + 中心点"""
    im = canvas()
    d = ImageDraw.Draw(im)
    c = N * S / 2
    for r, col in ((10 * S, 0), (7.6 * S, 255)):
        d.polygon([(c, c - r), (c + r, c), (c, c + r), (c - r, c)], fill=col)
    d.rectangle([c - 2 * S, c - 2 * S, c + 2 * S - 1, c + 2 * S - 1], fill=0)
    return to_bits(im, 0.5)


def yun():
    """云头：三圆并集的轮廓 + 底线"""
    im = canvas()
    d = ImageDraw.Draw(im)
    circles = ((7, 14, 5), (17, 14, 5), (12, 9, 6))
    w = 1.8
    for cx, cy, r in circles:
        d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=0)
    for cx, cy, r in circles:
        r2 = r - w
        d.ellipse([(cx - r2) * S, (cy - r2) * S, (cx + r2) * S, (cy + r2) * S], fill=255)
    d.rectangle([2 * S, 17 * S, 22 * S, 20 * S], fill=255)
    d.rectangle([2 * S, 18.5 * S, 22 * S, 20.3 * S], fill=0)
    return to_bits(im, 0.5)


def su():
    """素雅：上下两道细线 + 中间小方点（整格通线，平铺后连成一条）"""
    bits = [[0] * N for _ in range(N)]
    for y in (8, 9, 14, 15):
        for x in range(N):
            bits[y][x] = 1
    for y in range(10, 14):
        for x in range(10, 14):
            bits[y][x] = 1
    return bits


def to_hex(bits):
    out = []
    for row in bits:
        for b in range(0, N, 8):
            v = 0
            for i in range(8):
                v = (v << 1) | row[b + i]
            out.append('%02x' % v)
    return ''.join(out)


def show(name, bits):
    print(name)
    for row in bits:
        print(''.join('#' if v else '.' for v in row))


CELLS = {
    'xi': glyph('囍'), 'shou': glyph('寿'), 'fu': glyph('福'),
    'hui': hui(), 'dia': dia(), 'yun': yun(), 'su': su(),
}

if __name__ == '__main__':
    import sys
    if '--show' in sys.argv:
        for k, v in CELLS.items():
            show(k, v)
    lines = ['// 小票花边点阵块（由 tools/gen_border_tiles.py 生成，勿手改）',
             '// 每块 24x24 点，24 行 x 3 字节，十六进制；1 = 黑点。字形取自 Noto Serif SC（OFL）',
             'module.exports = {']
    ks = list(CELLS)
    for i, k in enumerate(ks):
        lines.append("  %s: '%s'%s" % (k, to_hex(CELLS[k]), ',' if i < len(ks) - 1 else ''))
    lines.append('};')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print('wrote', OUT)
