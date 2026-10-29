---
name: project-admin-warm-faq-eval
description: 2026-10-28 评估（v3.66.7后）：admin页折叠、预热覆盖、订阅延长具体时间、FAQ补全，待用户选A/B
metadata:
  type: project
---

四项评估已交付，待用户选择。要点：admin.wxml 11块可折叠；WARMABLE 不含 export/system，默认 functions 不含 renqing；setPlan 只能「加天数」、无日志、不能缩短（free=取消）；FAQ 71条，高峰模式条未写「仅会员」，缺离线礼簿码/打印机状态/等待确认等。
**Why:** 用户要转发微信，需通俗A/B方案。
**How to apply:** 用户回复选择后再实现；订阅日志写 admin_logs（logAdmin 在 system/index.js ~457）。
