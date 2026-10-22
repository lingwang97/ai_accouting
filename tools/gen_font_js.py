"""把 PDF 用中文字体打包成云函数可 require 的 JS 模块（base64）。

线上云函数运行时读不到随代码上传的 .ttf 文件（/var/user/fonts 下缺失），
改为把字体作为 JS 代码打包，随 index.js 一起加载，保证一定存在。
字体（均为 GB2312 子集 TrueType，SIL OFL 1.1，授权文本见 tools/fonts/OFL-*.txt）：
  - font-data.js   思源黑体（默认）
  - font-serif.js  思源宋体 Noto Serif SC（可变字体取 wght=500 后子集）
  - font-brush.js  马善政楷书 Ma Shan Zheng（毛笔风格）
用法：python tools/gen_font_js.py
"""
import base64, os

root = os.path.dirname(__file__)
out_dir = os.path.join(root, '..', 'cloudfunctions', 'export')
FONTS = [
    ('NotoSansSC-Subset.ttf', 'font-data.js', '思源黑体 GB2312 子集 TrueType（SIL OFL）'),
    ('NotoSerifSC-Subset.ttf', 'font-serif.js', '思源宋体 Noto Serif SC (wght 500) GB2312 子集 TrueType（SIL OFL 1.1）'),
    ('MaShanZheng-Subset.ttf', 'font-brush.js', '马善政楷书 Ma Shan Zheng GB2312 子集 TrueType（SIL OFL 1.1，Google Fonts）'),
]
os.makedirs(out_dir, exist_ok=True)
for src, dst, desc in FONTS:
    data = base64.b64encode(open(os.path.join(root, 'fonts', src), 'rb').read()).decode('ascii')
    path = os.path.join(out_dir, dst)
    with open(path, 'w', encoding='utf-8') as f:
        f.write('/* ' + desc + '，base64；由 tools/gen_font_js.py 生成，勿手改 */\n')
        f.write("module.exports = '" + data + "';\n")
    print(dst, os.path.getsize(path), 'bytes')
