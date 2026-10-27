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

## 2026-10-23 v3.44.0 已实施（HEAD 4f03a8e，未上传）
提交 572e3fb..4f03a8e（7 个）。用户确认四版计划：v3.44 数据稳定→v3.45 补功能→v3.46 性能→v3.47 工程，后三版另派。
设计：记账人读 payCodeFileID 占位 '@current'（account.KEEP_CODE），save 时换回；合计自愈在 books.stats / records.reconcile 里 checkDrift；recalc 在 bookedit 页。

## 2026-10-23 v3.45.0 已实施（未上传）
提交 57adbd0(amend 后端+撤销未收到)、后续 UI/守卫/提醒撤回/归档清理/邀请提示、版本与文档 §137。amend 用 amendN 乐观锁；personKey 改名：有 openid 且无 personKey 时固定为 o:openid:原名。rejected 无旧 rejectedAt，旧记录不可撤销。

## 2026-10-23 v3.46.0 已实施（HEAD d3c03 11d3c03，未上传）
提交 86d2a2e..11d3c03（11 条，文档 §138）。要点：pendingStat withExtra 返回 stall/rej 条数；outList 手动 top-N + 自动内存合并（outpage.js）；records 行「更多」ActionSheet 收区分备注/作废；poller 5 分钟无变化放慢 60 秒。待用户：一键建索引、最低基础库 2.21.2、booktheme 键盘真机验证。

## 2026-10-23 v3.47.0 已实施（HEAD 7624667，未上传）
提交 3e3c81b..7624667（4 个，文档 §139）。status.js/common.js/collections.js 入 sync_shared（status.js 还同步到 miniprogram/utils）；tests/ 用 `node tests/run.js`（export.test 需 NODE_PATH 指向装了 pdfkit/exceljs 的目录，否则跳过）。导出字体已外置云存储，export 包 7.9MB→72KB；**用户必须在管理员页点一次「上传导出字体」**（fontsetup 云函数，上传后可删），此前 PDF 提示「字体准备中」。测试里禁止对 Buffer 用 assert.strictEqual（失败时 diff 几 MB 会卡死）。

## 2026-10-25 全项目审查（HEAD 1f5c872 v3.58.0，已上传）只审查，未修
重点看 7624667..1f5c872（小票二维码/认领/_wxaCode/BLE MTU/PDF 预览/重名排序）。sync --check OK，tests 115 过。无严重。
条目：高1 rcptQr 缓存 key 不含 envVersion（体验版码被正式版补打复用，payment:897）；中2 二维码默认开+iOS 20 字节包每张≥10s、安卓 182B/20ms 廉价机溢出待验证（需用户决定默认开关）；中3 issueQr NEED 缺 show（只有打印权限的记账人无码）；中4 生成失败无熔断每张重试；中5 claim 人传 batch:true 可看整批回执（payment:558）；低6 回收站彻底删/purgeBook/trash_records 不删 rcptqr 文件；低7 urlnonce_* 超时残留；低8 qrcode-lib 56KB 主包死代码；低9 printtpl/tplGet 遗留；低10 receipt 页 isHost 冷启动不准；低11 personRef 未校验 canBook。
下次从 1f5c872 增量。

## 2026-10-25 上述 11 条已全修（未上传）
提交 3bb1388(v3.58.1: 1/3/4/5/10) 7bdfdd2(v3.59.0: 2 方案 C + FAQ 61 条) 8ea11d2(v3.59.1: 6/7/8/9/11)，文档 §159~161。下次从 8ea11d2 增量。
要点：rcptQrKey = token:w280v1:<env>；前端熔断 printer._qrBytes/resetQrBreaker；payment openapi -604101 实例跳过 10 分钟；qrOn 只认 qr===true；ble 限速 gapOf=max(20ms,len/4000B/s)、iOS getBLEMTU、稳定模式 storage printerSlow；qrcode-lib 与 printtpl 已删（控制台待删 printtpl 函数）。
测试注意：fakedb doc().get 返回同一对象引用，update 会原地改，需要旧值时先拷出来；loadFunction 每次重载模块（实例内状态要用同一个 m 测）。
