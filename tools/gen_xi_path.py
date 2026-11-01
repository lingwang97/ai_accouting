"""提取宋体「囍」(U+56CD) 的字形轮廓，写成矢量路径模块 cloudfunctions/export/xipath.js（v3.83.0）。

封面纹样「囍字」用 doc.path() 直接画这段路径，不依赖运行时字体，黑体 / 宋体 / 毛笔主题都能出图。
来源：Noto Serif SC（思源宋体，SIL Open Font License 1.1，tools/fonts/OFL-NotoSerifSC.txt），取自本仓库的 NotoSerifSC-Subset.ttf。
用法：python tools/gen_xi_path.py
"""
import os
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

root = os.path.dirname(os.path.abspath(__file__))
font = TTFont(os.path.join(root, 'fonts', 'NotoSerifSC-Subset.ttf'))
gs = font.getGlyphSet()
name = font.getBestCmap()[0x56CD]
upm = font['head'].unitsPerEm
pen = SVGPathPen(gs, ntos=lambda v: str(int(round(v))))
gs[name].draw(pen)
bp = BoundsPen(gs)
gs[name].draw(bp)
x0, y0, x1, y1 = [int(round(v)) for v in bp.bounds]
d = pen.getCommands()
out = os.path.join(root, '..', 'cloudfunctions', 'export', 'xipath.js')
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write('// xipath.js — 「囍」(U+56CD) 的字形轮廓（矢量路径，y 轴向上，单位 1/%d em），封面纹样「囍字」用 doc.path 绘制。\n' % upm)
    f.write('// 来源：Noto Serif SC（思源宋体，SIL Open Font License 1.1，见 tools/fonts/OFL-NotoSerifSC.txt），由 tools/gen_xi_path.py 从 NotoSerifSC-Subset.ttf 提取，勿手改。\n')
    f.write('module.exports = {\n  bbox: [%d, %d, %d, %d],\n  d: %r\n};\n' % (x0, y0, x1, y1, d))
print('upm', upm, 'bbox', (x0, y0, x1, y1), 'path chars', len(d))
