"""把 PDF 用中文字体打包成云函数可 require 的 JS 模块（base64）。

线上云函数运行时读不到随代码上传的 .ttf 文件（/var/user/fonts 下缺失），
改为把字体作为 JS 代码打包，随 index.js 一起加载，保证一定存在。
字体：思源黑体 GB2312 子集（SIL OFL），已转为 TrueType 轮廓。
用法：python tools/gen_font_js.py
"""
import base64, os

root = os.path.dirname(__file__)
src = os.path.join(root, 'fonts', 'NotoSansSC-Subset.ttf')
dst = os.path.join(root, '..', 'cloudfunctions', 'export', 'font-data.js')
data = base64.b64encode(open(src, 'rb').read()).decode('ascii')
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, 'w', encoding='utf-8') as f:
    f.write('/* 思源黑体 GB2312 子集 TrueType（SIL OFL），base64；由 tools/gen_font_js.py 生成，勿手改 */\n')
    f.write("module.exports = '" + data + "';\n")
print(os.path.getsize(dst), 'bytes')
