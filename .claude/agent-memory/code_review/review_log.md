---
name: review-log
description: 已审查的提交范围、已修复/待决定的问题（下次从最后 hash 增量审查）
metadata:
  type: project
---

## 2026-10-21 审查 c8ae6cb..ad508db（v3.25.0~v3.27.0）
7 条用户确认全修，a75e77d（v3.27.1）已修复并上传。

## 2026-10-22 审查 a75e77d..176eb57（v3.27.2~v3.31.0）
5 条全修：3/4/5 在 6d36f9b（v3.31.1），1/2 在 fe8e2ce（v3.31.2）。

## 2026-10-22 全项目审查（HEAD fb869b9，v3.35.0）
报告 13 条，待用户选修：
1 高：默认礼簿 _id=default_<32位aid>=40 字符 > scene 32 上限，本场礼簿码生成失败（qrcode:41）
2 高：cashEntry 无幂等键，礼台弱网重试重复入簿
3 中：存档 PDF 绕过「对账与导出」权限（books.list 返回 archivePdf + bookdetail 按钮）——需用户决定
4 中：records/pending 每 5 秒轮询重查询；refreshBadge 用重的 pending
5 中：trashPurge 在 moving 未移完时就删，剩余 records 成孤儿
6 中：renqing fetchAll limit(100)，3000 条 30 次串行
7 中：记账人改/移家人共享无范围保护（wider 对 viewer 恒 false）
8~13 低：导出路径含主家 openid、KEY_SECRET 写死、主包 1.5MB 无分包、init/索引缺 trash_*、qrcode 透出 errMsg / printtpl 旧接口、openfile 本地文件堆积
下次从 fb869b9 之后增量审查。

## 已知未处理的小边界
- 无 bookId 的批次待确认在礼簿页点确认会提示「已处理」（旧数据会被 migrateOrphans 归入默认礼簿）。
- 待确认 limit(100) 按记录截断，批次可能被拆开（>100 笔待确认时）。

## 环境限制
- CLI 无法调用云函数/查库，线上数据量只能让用户在控制台高级查询确认。

## 高风险模式
- 确认/拒绝限定 workBook（payment notCurrentBook）：新增确认入口要同步考虑当前礼簿。
- 角标 setBadge 口径必须是当前礼簿待确认数。
- 前端汇总服务端已截断的列表（300 人 / 3000 条）会少算，合计应由服务端算。
- 金额上限改动要搜全：payment、renqing、account.quickAmounts、前端 maxlength。
- 任何用作小程序码 scene 的 id 必须 ≤32 字符（default_ 前缀礼簿会超）。
- 前端「可见即可下载」的 fileID（archivePdf、导出）要对照权限项。

## 2026-10-22 全项目审查 13 条已全修（v3.36.0~v3.37.0，HEAD 67b506d，未上传）
用户选 3=A、4=10 秒。提交：87d3bab(1 短码 book_codes) 28f9882(2 reqId 幂等，记录 _id=q+md5) faedd5a(5) 437aa0d(3) 7878383(4+6) 32d79a1(7) 8e67734(8+9) 2e15bcf(11~13) 67b506d(10 分包，root=页面目录，路径不变)。
下次从 67b506d 增量审查。

## v3.39.0~v3.41.0 修复计划已全部实施（HEAD 3b907c 系列，v3.41.0 未上传）
v3.41.0 提交 f6f417a/c98ab79/1b9e322/3b907fc。第 18 条 _openid 过滤被跳过：v3.11.0 前付款方曾直连写 records，旧记录可能带 _openid，加过滤会让旧记录无法确认/打印。
注意：Bash 工具会把 heredoc 里的双反斜杠折成单个，改含 \n \s 的源码用 Edit 工具，别用 python 脚本。

## 2026-10-23 第1组审查（数据安全/稳定性，HEAD c5a7d4b v3.43.0）只审查，未修
全仓排查链式 where/aggregate match 漏 ownerOpenid：无同类问题。共享模块 17 份副本与 tools/cloud-shared 全一致。无严重/高。
报告条目：中 transfer 未迁移 book_codes(account:622)；中 purge/purgeBook 漏默认礼簿短码图片(purge.js:75,system:258)；中 statCount/statFen 无自愈(payment:392,692)；中 主家邀请卡直发 5 人直接生效(account:339,531，待产品决定)；低 expirePending 失败拖垮读(records:29)、clerk(info)可见 payCodeFileID 含主家 openid、warmer pushOne 更新失败重复推送、orgSummary/themes 聚合 limit 截断、init 无鉴权、printtpl 遗留。
待确认：集合/存储权限（控制台）、export 内存配置、aggregate limit(10000) 是否被平台截断。
