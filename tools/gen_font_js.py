"""把导出用中文字体打包成 fontsetup 云函数可 require 的 JS 模块（base64），用于一次性上传到云存储。

v3.47.0 起 export 云函数不再打包字体（包体积 7.9MB -> 约 1MB），字体放云存储 export-fonts/，
export 首次使用时下载到 /tmp 缓存。fontsetup 是一次性的上传工具：
  1. python tools/gen_font_js.py          生成 cloudfunctions/fontsetup/font-*.js（已 .gitignore，不入库）
  2. 部署 fontsetup 云函数（cli cloud functions deploy --n fontsetup --r ...）
  3. 管理员页「上线前检查」点「上传导出字体」（要管理员身份）
  4. 上传成功后可在云开发控制台删除 fontsetup 云函数（字体已在云存储）
字体（均为 GB2312 子集 TrueType，SIL OFL 1.1，授权文本见 tools/fonts/OFL-*.txt，.ttf 源文件保留在 tools/fonts/）：
  - font-sans.js   思源黑体（所有 PDF 都用）
  - font-serif.js  思源宋体 Noto Serif SC（可变字体取 wght=500 后子集）
  - font-brush.js  马善政楷书 Ma Shan Zheng（毛笔风格）
"""
import base64, os

root = os.path.dirname(__file__)
out_dir = os.path.join(root, '..', 'cloudfunctions', 'fontsetup')
FONTS = [
    ('NotoSansSC-Subset.ttf', 'font-sans.js', '思源黑体 GB2312 子集 TrueType（SIL OFL）'),
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
