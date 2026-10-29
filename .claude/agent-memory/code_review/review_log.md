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

## 2026-10-27 体验评估（HEAD f031afb v3.65.0）只评估，未修
用户问「除刷新频率外还有哪些影响体验的问题」。报告 15 条（UX1~UX15），要点：弱网失败被显示成空/无效且无重试（pending「全部处理完了」、records「暂无」、index 退成宾客页、pay「礼簿码无效」、invite「已失效」）；轮询非 silent 弱网反复弹「网络异常」(records recordList、pending recordPending)；无打印机每次确认提示「打印机未连接」、打印机关机每笔确认卡约 6 秒；礼台页无打印机状态/不自动聚焦/每笔 2 次串行调用；宾客等待页「请勿关闭」且离开后看不到进度；pay 无加载态；礼簿码页串行加载无离线兜底；机构模式文案残留「记账人」。
已核实无需报：订阅次数用完已有工作台提示(notify.tipText 43101)；BLE 断开下次打印自动重连。

## 2026-10-27 体验修复已实施（未上传，云函数部署被权限拦截）
UX1~UX15 全做：310490e(v3.65.2，纯前端) 15da87f(v3.66.0，文档 §181~182)。UX5 选 A，UX13 选 A；宾客入簿订阅模板待用户提供 ID，接入点 pay.askGuestNotify()。
v3.66.0 需部署 records、payment（CLI deploy 被 auto mode 拦截，未部署）。**payment 必须先于前端上线**：新前端 cashEntry 带 nameCheck:true，旧 payment 会忽略并跳过同名选择直接入簿。
新增共享模块 namecheck.js（records+payment），plans.js 同步到 records（refreshOf）。
坑：Bash heredoc 里 python 字符串的 \u3000 会变成真字符，含反斜杠的源码改用 python -c chr(92) 或 Edit；fakedb add 默认不落数据，需 db.persist=true，且重复 _id 不报错（测试里自己包一层）。
v3.66.1（宾客入簿通知）已提交，payment 部署又被 auto mode 拦截（主会话代为部署过 v3.66.0 的 records/payment）。发送入口只有 payment confirm / confirmBatch → afterPaid；guestNotifiedAt 原子占位防重复。

## 2026-10-28 全面审查（HEAD b81f216 v3.68.0，已上传）只审查，未修
sync --check OK，tests 275 过 25 跳过。无严重。已抽查未回退：rcptQrKey 含 env、issueQr NEED 含 show、claim 不能看整批、personRef canBook。
新 action 鉴权均到位（setGiftNotify/setPollLevel/setPeak/setTrashDays/advGet/adminSetPlan guard），takeUse、guestNotifiedAt 原子占位正常。
条目：高1 轮询成本（pendingStat 每次 resolveCtx 3~5 读 + 4 查询，3 秒档免费开放、高峰 8h 不放慢、每位记账人各轮询）；
中2 清除数据不删 avatars/ 头像文件、换头像旧文件不删、rate_limits nc_ 残留；中3 afterPaid 最多多等 3 秒且超时后已占位不补发；
中4 家人升级记账人（主家卡，account:511-529）跳过额度、回收站恢复不受礼簿额度（需用户决定）；中5 settings/plans 文档整体覆盖默认套餐（控制台确认是否存在）；中6 控制台确认 export 内存/各函数超时/warmer 触发器；
低：入簿通知点开批次只显示本人一条、头像文件名含 openid 后 12 位且 login 不校验 avatar、hasPeak 无索引串行 planOf、离线礼簿码图片切身份/清除后留在本机、miniprogram/.claude 目录、ownPayCode 三处重复、setPeak 无防连点。
下次从 b81f216 增量。

## 2026-10-28 上述审查已修（未上传，云函数未部署：CLI deploy 被 auto mode 拦截）
71c0e68 v3.68.1（#2#3#4#8，§195）、89076e7 v3.69.0（#1#9，§196）、f5d0cc6 v3.69.1（#7#10#11#12#13，§197）。下次从 f5d0cc6 增量。
待部署：payment warmer account books login system records（payment 与 warmer 必须同时部署，共用 guestnotify.js）。
设计要点：入簿通知 guestNotifyTry/guestNotifyDone，可重试失败撤销占位由 warmer.retryPending 补发；一次性订阅补发重复会得 43101 所以不会发两条。
refreshMinSec（free 8 / pro 3，缺项=3 开放）；records 轮询缓存 ctx(aid,15s)/other(30s,pending 写回)/sum(count 不变)/remindDue(rv,5min)。
测试坑：fakedb doc().update 不落数据（login/members 只能断言返回值或日志）；fakedb 已支持 _.remove() 与 Date 等值。

## 2026-10-28 v3.70.0 智能刷新（358496c，§198，未上传未部署）
用户决定去掉手动刷新档位：poller boost 5s 10 分钟全局窗口 + 标准放慢，kick 回 10s，hold(高峰 3s) 优先；服务端 refreshOf.pollLevel 恒 off，setPollLevel 保留为不写库返回 off；plans 的 fastRefresh/refreshMinSec 保留不用。
待部署 account records（CLI 被拦截）。下次从 358496c 增量。

## 2026-10-28 上线就绪评估（HEAD 2c09724 v3.70.1，已上传体验版）只评估，未修
结论：有条件上线（小范围灰度）。sync OK，tests 300 过 25 跳过（export PDF 测试因本地无 pdfkit 跳过）。
CLI `cloud functions info` 可查超时：12 个函数均 Active、Node16.13，超时已配（payment/records/books/renqing/qrcode 20，account/warmer/system/export/fontsetup 60，login/init 10）；查不到内存与代码版本。
git 实际领先 origin 22 个提交（非 100+），remote=github lingwang97/ai_accouting，可见性未知（无 gh）。
新发现：setClipboardData（mine.js:152、reconcile.js:139）未写进隐私指引清单（缺「剪切板」）；全项目无 msgSecCheck/mediaCheckAsync（礼簿名/称呼/收款码图对宾客可见）；宾客等待页 3 秒轮询最长 10 分钟是高并发主要成本；预热默认 paid，无付费用户时不预热；会员无支付入口（个人主体）有审核风险。
personkey 设置 env PERSON_KEY_SECRET 会改变所有已存 h: 标识，不要建议补设。
