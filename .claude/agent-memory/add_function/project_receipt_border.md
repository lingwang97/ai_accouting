---
name: project-receipt-border
description: 小票四周花边（礼簿自定义纹路）评估，推荐混合方案（上下光栅带+左右字符），待用户选择，目标 v3.60.0
metadata:
  type: project
---

评估日期 2026-10-26（HEAD c7c0191 v3.59.5）。结论：推荐 C 混合（上下 GS v 0 光栅带约 24 点高，左右每行首尾 2 列 GBK 全角装饰字符）；纯字符为备选；全光栅否决（58mm 约 30KB/7s、80mm 约 43KB/11s）。
关键点：ble 限速 4KB/s 与 MTU 无关；内容宽度 32/48 列各减 4 列；ESC a 对齐要改为手工补空格；倍大字行需切字号再补空格；行距默认大于 24 点，竖线会断，侧边用独立图案字符更稳；预览 printset.buildPreview 需同步。存 printTpl（books.saveTpl 白名单需加字段，如 border:'off'|'auto'|key）。

**Why:** 用户要求给非技术 A/B/C 选项。
**How to apply:** 用户选定后再实现；真机先做「纹路测试页」验证 GBK 制表符/◆★ 在用户机器上能否打印。
