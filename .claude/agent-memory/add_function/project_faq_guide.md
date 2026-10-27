---
name: project-faq-guide
description: 「使用教程与常见问题」评估（2026-10，HEAD v3.50.0 后）：教程页 guide 加第4分页「常见问题」的草稿与页面方案，待用户确认
metadata:
  type: project
---

需求：「我的」菜单「使用教程」改名「使用教程与常见问题」，guide 页加常见问题（约 50 条，11 类）。先评估出草稿，用户确认后才改。

要点（实现时用）：
- guide 页：pages/guide/guide.js 的 GUIDES / TABS / secsOf；mine.wxml:80 菜单文案；guide.json 标题；教程入口仅登录后可见（mine 的 user 块内），未登录宾客无入口（index 的 guideTip 只给老用户）。
- 事实核对坑：礼簿页无导出按钮（导出在 我的→导出与备份 / 礼簿管理）；退出登录只清本机，不删云端数据；清除数据入口「清除我的全部数据」；传统礼簿单次 3000 笔、其他导出 10000 笔上限；打印非 GBK 字符变「?」；待转账 30 分钟自动取消；「宾客未点完成」3 分钟后出现；未收到 24 小时内可撤销（旧记录不可）。
**Why:** 用户要求每条问答必须对应真实入口。
**How to apply:** 实现时 FAQ 数据另放 utils 或 guide 内常量，改入口时同步（沿用 guide.js 文件头约定）。
