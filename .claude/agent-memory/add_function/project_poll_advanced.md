---
name: project-poll-advanced
description: v3.60.3 转账提醒提速、v3.61.0 高级功能页与待确认刷新频率已实现，位置与踩坑
metadata:
  type: project
---

v3.60.3 payment notifyOwner 复用 payerUpdate 的 out.rec、并行查询、60 秒收件人缓存（tests/notify.test.js）。
v3.61.0 pages/advanced（子包）+ users.pollLevel（off/low/mid/high）+ account.setPollLevel；poller 新参数 fast、30 分钟退回；utils/pollcfg.js 本机缓存；plans.js 新增 fastRefresh 与 effectivePollLevel（features 缺项视为开放）。
**Why:** 用户要办事当天更快看到待确认。**How to apply:** 系统设置页没有套餐 features 编辑，关功能需在控制台改 settings/plans 文档。CLI 部署偶发 ETIMEDOUT，重试即可。
