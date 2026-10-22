---
name: review-log
description: 已审查的提交范围、已修复/待决定的问题（下次从最后 hash 增量审查）
metadata:
  type: project
---

## 2026-10-21 审查 c8ae6cb..ad508db（v3.25.0~v3.27.0）
7 条用户确认全修，a75e77d（v3.27.1）已修复并上传。

## 2026-10-22 审查 a75e77d..176eb57（v3.27.2~v3.31.0）
报告待用户决定：
1. 往来页「共收到 N 笔/合计」由前端累加 people（服务端 slice 前 300 人）→ 超 300 人少算
2. 工作台提醒 ✕ 签名只用文案，「次数已用完」文案固定 → 关一次后永不再提示
3. account quickAmounts 上限仍 10 万，与单笔 1000 万不一致
4. 金额上限常量 payment/renqing 各写一份
5. pending.wxss 注释「至少 4 个字」与 min-width:2em 不符
3/4/5 已在 6d36f9b（v3.31.1）修复（共享 limits.js）。
1/2 用户选定方案后在 fe8e2ce（v3.31.2）修复：people() 并行 DB 聚合返回 inTotal/inSum/more；
工作台提醒关闭记 {文案, lastNotify.at, 关闭时刻}，新失败且过 30 分钟重现。全部 5 条已修，未上传。
下次从 fe8e2ce 之后增量审查。

## 已知未处理的小边界
- 无 bookId 的批次待确认在礼簿页点确认会提示「已处理」（旧数据会被 migrateOrphans 归入默认礼簿）。

## 环境限制
- CLI 无法调用云函数/查库，线上数据量只能让用户在控制台高级查询确认。

## 高风险模式
- 确认/拒绝限定 workBook（payment notCurrentBook）：新增确认入口要同步考虑当前礼簿。
- 角标 setBadge 口径必须是当前礼簿待确认数。
- 前端汇总服务端已截断的列表（300 人 / 3000 条）会少算，合计应由服务端算。
- 金额上限改动要搜全：payment、renqing、account.quickAmounts、前端 maxlength。
