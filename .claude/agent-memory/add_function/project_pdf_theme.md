---
name: pdf-theme-eval
description: 传统礼簿 PDF 主题需求（v3.32.0 预设10种、v3.33.0 自定义+宋体/毛笔，已本地提交未上传）
metadata:
  type: project
---

用户选择「1A 2每本 3要 4不改 5维持」。传统礼簿 PDF（export 云函数 buildBook）本来就有，新增的是主题。

- 主题表 cloudfunctions/export/themes.js；前端清单 miniprogram/utils/pdftheme.js；存 books.pdfTheme={key,custom?}；白事强制素灰（resolve）。
- 字体：font-data.js 黑体、font-serif.js 思源宋体、font-brush.js 马善政楷书，均 OFL、懒加载；毛笔小字用 sub 字体（黑体）。tools/gen_font_js.py 生成。
- 本地测试 pdfkit：在 $TEMP 另建目录 npm i pdfkit，stub wx-server-sdk，复制 index.js 并追加 module.exports.__t 导出 buildBook，用 pymupdf 转图看效果。
- 踩坑：Bash 长 heredoc 含大量引号时可能整体解析失败，改用 Write 工具写 python 脚本。
- 版本 3.32.0 (3b5a26b)、3.33.0 (3aab86c)。
- v3.34.0 (063c1bd)：新增 pages/booktheme 主题页（先选主题再导出）、白事可编辑(sanitizeFuneral)、囍水印用宋体；Bash 长 heredoc 易失败，用 Write 写脚本
