---
name: project-receipt-print-qr
description: 58mm 小票 v3.56.0 自定义元素+留白、v3.57.0 二维码(URL Link)+认领；URL Link 30天且首位扫开者限制
metadata:
  type: project
---

v3.56.0 (f81a5ac)：printTpl 新增 amountUpper/receiptNo/payMethod 字段、footer、amountSize、titleAlign/Bold、showHandler、feedTop(0-4,默认1)/feedBottom(2-8,默认5)。旧模板 fields 不改，只补标量默认值。
v3.57.0 (4ae494f)：records.rcptToken/claimedOpenid；payment 新增 issueQr/resetToken/unclaim(OWNER_ACTIONS)+receiptByToken/claimReceipt(宾客侧)；qrprint 原生 GS(k / 图片 GS v 0（矩阵直接转光栅，无需 canvas）。

**Why:** 用户选 1B（URL Link）；查官方公告发现 URL Link 最长 30 天、首位扫开的微信用户独占，已向用户如实汇报；备选 wxacode.getUnlimited（永久）需图片打印。
**How to apply:** 再改二维码方案时先看此限制；heredoc 里含三引号或 \r\n 的 Python 脚本用 Write 工具写文件，别用 bash heredoc。
