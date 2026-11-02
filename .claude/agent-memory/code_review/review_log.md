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

## 2026-10-29 核实外部报告 docs/review_before_online.md（HEAD 5f7dad7 v3.71.2）只核实，未修
来源：外部报告（基线另一分支 97deaba，内容与当前一致）。本机 tests 341 过 0 失败、sync OK。
属实（待修）：
- P0-3 records list/aggregate、payment getRecord、account members(862/918/954/1106) 未过滤 _openid；personkey 读到伪造 person_key 文档→返回 LEGACY 公开密钥（personkey.js:26,48,60）；preflight 不能查集合权限（SDK 无 ACL 接口；可在管理员页前端用 wx.cloud.database() 读探测，非 -502003 即未锁）。ensureCol/createCollection 自建集合默认权限非「不可读写」。注意：records 加 _openid 过滤与 v3.41.0 决定冲突（v3.11 前旧记录带 _openid），需用户先清测试数据或决定。
- P1-1 payment RATE_MAX(:122-126 count 后判断) 与 sameNameQuota(:230-245 get 后 set) 都是先读后写，并发可绕过；无礼簿维度上限；rate_limits 无清理（NOT_PURGED 注释「短期自清理」不实）。
- P1-3 ctx.js:48 safe() 吞异常：users 读失败→currentAid 丢失→当成本人主家（礼台记账可能记进自己的礼簿）；accounts 失败→落到记账人分支；members 失败→当主家。
- P1-4 receipt.json 无导航色（继承 app.json 红），receipt.js:43-48 model 先 setData、白事色后设。
- P1-5 account.js:129 bookedit.js:61 setup.js:90 chooseMedia 无 sizeType/compressImage；secure.js:72 >1MB 跳过审核。
- P1-7 qrcode.js:34 模拟随礼仅 develop/trial；审核版 envVersion 待验证。P1-2 wipeAll 仅 launch 标记前可用（设计如此，清单项）。
- P2 属实：1(account:252 先查再写 add)、2(trash.js:45-48 set 后 remove 中断，续跑不再删 books)、3(purgeExpired 无 deadline)、4(statFen 中断后 duplicate 不累加，靠 checkDrift)、5、6(移交卡不绑定接收人)、7(存储所有人可读→archivePdf fileID 永久可下)、8、9、10、11、13(PEAK 3s/BOOST 5s)、14、15、16、19(无 onNeedPrivacyAuthorization)。
- P2-18：本机不复现（相关 js 工作区是 LF），但 autocrlf=true、无 .gitattributes、190 个文件工作区 CRLF，新克隆会误报；export/index.js:799 含原始 \0 \x1F \x7F 字节（git 识别为二进制，属实）。
- P0-2 属实：提审文档超时/触发器(实际只 warmer+export 2 个)/索引(代码 30 条 vs 文档 19)过期；但控制台超时 10-28 已按 config.json 配好。checklist 云调用权限漏了 qrcode 的 wxacode.getUnlimited。
- P3 抽查属实：amend/setNameTag 无内容审核、secure.js:42 日志打前 20 字、viewer 可调 export cleanup、qrCacheFiles skip 无 orderBy、resumeStuck limit(20)、remindDelete 无确认、money 无千分位、escpos wrap 按 charCode>255、ble.js:277 未传 writeType、index 无下拉刷新、隐私文档「仅主家与宾客本人可见」不准。
用户已决策：P1-6 会员文案保留「联系我们开通」。

## 2026-10-29 外部报告确认项已修（v3.72.0~v3.72.2，未上传，云函数已部署）
提交 e3beb1c(v3.72.0 §203) 9539554(v3.72.1 §204) 16e05a4(v3.72.2 §205)。下次从 16e05a4 增量。
已修：P1-1 原子限流（payment.takeSlot，rate_limits 键+时间桶，rp_/rb_/nc_，BOOK_RATE_MAX=60，reqId 重放不计数，warmer 清 1 天前）；P1-3 ctx.safe 只对不存在降级，其余抛 ctxFail → common.failOf 返回 code 2，request.js 按网络错误；P0-3 personkey 伪造报错不回退 LEGACY（state=forged）、问1A ctx.srvCol 过滤 records（records/books/payment/renqing/export/namecheck）与 account members；问2A 记账人改家人共享只能收窄，新增走 addTo pending；P1-4 回执页导航 #F7F7F7；P1-5 utils/imgcompress；P0-1 宾客用语；P0-2/P1-7 提审文档第三节以代码为准。
v3.72.2 上线前检查：各函数 __meta（meta.js，context 读内存/超时，nonce 探测 openapi）、warmer_beat/export_cleanup_beat/index_status/preflight_last/launch_checklist 均在 settings。
坑：Windows 上 python open(...,'w') 会把 LF 写成 CRLF，tests 里按 \n 的正则（v3701 onLoad 首句）会失败；改文件用 'rb'/'wb' 或 newline=''。

## 2026-10-30 写账链路数据一致性专项（HEAD 0ab23d9 v3.75.0，已上传）只审查，未修
用户问「繁忙/弱网下会不会登记出错」。结论：核心状态流转都有条件更新，不会错状态；有 2 条上线前必修。
- 高1 cash.js:168-172+199-205 同名选择(needPick)后第二次调用换了新 reqId（payload 被加 personRef/tag，sig 变）；响应丢失后重点入簿→又一个新 reqId→本场同名弹窗选「这一位」→重复入簿。修：nameCheck 前按原 payload 定 reqId，两次调用复用（服务端已支持 done 跳过检查）。纯前端。
- 高2 payment getRecord(:1212) 吞所有读库错误当「记录不存在」：ownerUpdate:1104 更新成功后读失败→报错+不累加合计+不打印；status 轮询/transferred 对宾客弹「记录不存在」(pay.js:347 非 silent)→宾客可能重登。修：isMissing 才 null，其余抛 ctxFail；ownerUpdate 读失败用 r0+data 累加。
- 中3 宾客重复登记无防护：reqId 只在页面内存，create 超时后离开/重扫、现金宾客无 saveOpen；同人同名不触发 needTag。建议服务端同人同簿同名同额 30 分钟内提示 dupOf + 待确认标「疑似重复」。
- 中4 statFen 漂移：上面 1104 路径、inc+mark 双失败、backfill 窗口(books:186) 高峰丢累加、cashEntry 同 reqId 并发部分批次双加；只有 stats/reconcile 会 checkDrift。可见于工作台/礼簿列表/邀请卡(account:406)；统计/对账/导出是实时聚合正确。建议 dashboard 当前礼簿改实时聚合+checkDrift。
- 中5 限流数值：rb 60/min 大型宴会可能误伤；rp 3/min 同名流程占 2 次；nc 20/10min 批次 10 人+同名后再重试会被锁 10 分钟。
- 低：onTransferred 不看返回 status(pay.js:289，自己取消过的记录卡等待)；onCancel 不看返回 status(pay.js:309)；确认超时重试报「不可操作」且不打印(confirm.js:62)；groupUpdate failed>0 前端忽略；宾客批次部分写入；renqing outSave 无幂等；trash.js:45-48 P2-2 仍在；purge 的 rate_limits 条件 nc_+openid 与 v3.72 分桶 id 不匹配。
已确认安全：reqId 幂等(页面内)、transferred/cancel/confirm/reject/unreject/appeal/resolveAppeal/void/amend 条件更新、双记账人并发、guestNotifiedAt、status 3 秒缓存、markPrinted、purge/moveDocs 可重跑、takeSlot 原子且重放不计、request.js 无自动重试。
待验证：wx.cloud.callFunction 客户端超时时长；数据库 QPS 超限时是报错还是排队。
下次从 0ab23d9 增量。

## 2026-10-30 上述专项已修（用户「按建议修」）
- 66f0748 v3.75.1（§214）：高1 cash reqId 在 nameCheck 前按原表单定、选同名后复用；高2 getRecord 只 isMissing 返回 null、其余抛 ctxFail(code 2)，ownerUpdate 先读 r0（作废也读）、更新后读失败用 r0+plainOf(data)，transferred 提醒失败不影响；限流 5/150/40 + 文案「稍等几秒」+ pay 弹窗；L3 confirm/amend silent 调用、「不可操作/刚被修改」时 records.detail 核对按成功处理（req.showErr、req.recordDetail）。payment 已部署。
- c9ba9cf v3.76.0（§215）：⚠️3 create dupOf（需前端带 dupCheck:true，旧前端不检查；allowDup 跳过）、records.pending markDups/dupFlags 标 suspectDup、pending 页标签与确认弹窗提醒；⚠️4 dashboard liveBookStat 实时合计（30 秒缓存，累计值变即重算）+checkStatDrift。**payment、records 部署被 auto mode 拦截，未部署**。
- 未做待办：L1 onTransferred 不看返回 status；L2 onCancel 不看返回 status；L4 groupUpdate failed>0 前端不提示；L5 宾客批次部分写入；L6 renqing outSave 无幂等；L7 trash.js:45-48 中断；L8 purge rate_limits 条件与分桶 id 不匹配。
- tests 426 过。下次从 c9ba9cf 增量。

## 2026-10-30 上线前最后全面审查（HEAD 93e41ea v3.76.1）只审查，未修
sync OK，tests 406 过 0 失败 25 跳过。结论：有条件 go。抽查未回退：srvCol _openid 过滤、ctx.safe 抛 ctxFail、takeSlot 原子、personkey forged、getRecord isMissing。
新 action 鉴权到位：appeal 只认 payerOpenid+条件原子更新+ap_ 每天 5 次；resolveAppeal 在 OWNER_ACTIONS+NEED(confirm)，keep/accept 都校验 owner+canBook+当前礼簿；admin* 全走 guard。通知/时间线不含记账人姓名与 openid；status 缓存 key=openid|rid 不串人；dupCheck 旧前端不带即不检查；preflight 探测无副作用（模板 ID 不存在、固定文本、1x1 图、码只生成）；rejectNote/appealNote/appealReply 均过 msgSecCheck。
条目：高1 未收到/维持未收到通知复用「入簿通知」模板（guestnotify.js:54-68,182-221，申诉时又以该模板请求订阅）——订阅消息内容与模板标题不符的合规风险，需用户看后台模板标题决定（关通知 / 另申模板）；中2 申诉只统计/显示/处理当前礼簿（records appealCondOf bookId:cur、pendingStat、payment notCurrentBook），且推送仅给开了新礼金提醒的人→多场次/切换礼簿/归档后申诉无人看到；中3 __meta 不返回代码版本，preflight 查不出未部署（v3.76.0 payment/records 部署状态待确认）；中4 wipeAll 默认保留管理员数据、不清 book_codes/rate_limits/头像与小票码文件；低：pay.js:228 dupOf 二次出现静默返回、L8 purge 条件仍不匹配、L1/L2/L4~L7 仍在。
容量：DB QPS 30 先触顶（create≈12 次读写、confirm≈10、status 1、pendingStat 1~3）；单场 300 人高峰约 6~9 QPS，可同时撑约 3 场高峰；并发 20 约可撑 15 场。单场约 0.9~1 万次调用；预热 always 5 分钟 7 函数约 6.9 万次/月是最大固定开销。
下次从 93e41ea 增量。

## 2026-11-01 上线前最后全面审查（HEAD 0f642b9 v3.78.5，已上传体验版）只审查，未修
sync OK，tests 470 过 0 失败 25 跳过。结论：有条件 go（无严重/高；剩余为控制台与真机核对）。
抽查未回退：srvCol _openid 过滤、ctx.safe 抛 ctxFail、takeSlot 原子、personkey forged（renqing/personkey.js）、getRecord isMissing、cash reqId 复用、status 缓存 key 含 openid。
93e41ea 后无新 payment action；resolveAppeal/groupUpdate/ownerUpdate 跨礼簿只放开 notCurrentBook，仍校验 owner+canBook，accept 拦归档。viewer：dashboard bookId 只认 canBook+未归档+存在；records.list 对 readonly 去 rejectedBy/trail；OWNER_ACTIONS readonly 拦截不变。
上次高1（未收到复用入簿模板）已由 v3.77.0 独立模板 pOZ1…（guestRejectNotify 独立标记/额度）解决；旧前端只订入簿模板的不再发未收到通知。主家新礼金模板 sVsj…（thing1/thing4/amount7/time9/thing3）。
条目：中1 system/index.js:727 清单仍写「三个模板 ID」（实际 4 个）；中2 preflight 测试数据统计 keepAdmins:true(:709)、admin.js:26 清除默认保留管理员，与用户「全部清除」决策不一致，wipe 仍不清 book_codes/头像/小票码文件；
低：confirm.js:143 跨礼簿申诉入簿在当前礼台自动打印别场小票；confirm.js:118 归档礼簿仍给入簿选项（服务端拦）；records detail(:541) 对 viewer 仍返回 trail/rejectedBy；index.js:176-179 viewer needBooks 回退到主家当前礼簿；notify.js:89 换机/清缓存后误提示「已升级」；viewer 角标为主家当前礼簿待确认数；transfer.wxss:5 #f5f5f5 深色；L1/L2/L4~L8、trash.js:45-48 仍在。
下次从 0f642b9 增量。
- 已修 4244da9 v3.78.6（§229，用户确认 1A 2A 3A）：清单四模板+关键词、wipe 默认不保留管理员（preflight 统计含管理员）、pending 逐笔卡核对提示恢复。book_codes 只评估不清。**system 部署被 auto mode 拦截，未部署**。tests 498 过。坑：一行 try{...}catch 里插 // 注释会吃掉 catch。下次从 4244da9 增量。

## 2026-11-02 上线前全面审查（HEAD 38ec0bd v3.83.2，export 已部署未上传）只审查，未修
增量 4244da9..38ec0bd（v3.79.0~v3.83.2：封面照片、整页版式、crop、导出页重组 saveOnly、纹样/囍、字体预览、orgT）。sync OK，本机 tests 523 过 0 失败 40 跳过。结论：有条件 go，无严重/高。
抽查未回退：srvCol、ctx.safe→ctxFail、takeSlot、personkey forged、getRecord isMissing、wipe 前端默认不保留管理员。
鉴权已核实：setCoverPhoto/coverPhotoUrl 在 books 用 can(books)+canBook（viewer can() 恒 false）；ownCover 校验 covers/book-<caller>-<ts>.(jpg|png)；fontPreview 需 account、clerk 需 export 权限；saveOnly 需 can(books)；export coverOverride 只在 can(books)+已有照片+非白事时写库；deco 不属会员项；uploadPreview 走 isAdmin。（OWNER_ACTIONS/NEED 只是 payment 的机制，这些 action 不在 payment。）books.list 只回 coverView 不回 fileID。
条目：中1 wipeAll books 分支(system:478-480)与 adminPurgeBook(system:311-321)不删 coverPhoto 文件（文档 §230 说已清，实际只有 purge.fileIds/trash.filesOf 有）；中2 dropCover 用 ownCover(fileID, OWNER)(books:604-607,650,676)，记账人上传的旧照更换/移除时不删；中3 booktheme.js:415-418 setCover 响应丢失但已保存时前端删文件→礼簿指向已删照片（存档报错、普通导出静默无图）；
低：礼簿改白事后照片无移除入口(wxml:157)且 save 不清；coverPhotoUrl 临时链接含上传者完整 openid（covers 路径，与头像去 openid 不一致）；服务端 COVER_MAX 4MB 与 1.5MB 决策不一致；purge.js:73 `!b._openid` 应为 coverPhoto._openid；request.js:260 注释过时。
fontsetup 约 16.3MB（font-*.js 15MB + pvfont 1.4MB，gitignore），两种字体都上传后 preflight 提示删。
下次从 38ec0bd 增量。
- 已修 68be34d v3.83.3（§237，用户确认中1/中2/中3/低1/低3+低4/低5）：system isCoverFile（wipeAll books 分支 + purgeBook）；books dropCover 只认 covers/ 前缀；coverPhotoUrl 可带 fileID 回 is，前端网络失败先核对、核对失败保留文件；save 改 funeral 时 _.remove coverPhoto 并删文件，bookedit 弹窗「继续/取消」；COVER_MAX 与 export 上限 1.6MB；purge.fileIds field 取 _openid。已部署 books system export account（CLI 成功）。tests 570 过（带 NODE_PATH）。
  坑：fakedb Query.update 需 db.applyUpdates=true 才写入，且 db.reset()（seed 前）会把它清回 false；Bash heredoc 里 python 的 '\' 会被吞，含反斜杠的脚本用 Write 写文件、chr(92)。下次从 68be34d 增量。

## 2026-11-02 上线前审查（HEAD 5480a65 v3.84.1，已上传）只审查，未修
增量 38ec0bd..5480a65（v3.83.3 封面清理、v3.84.0/1 隐私勾选）。68be34d 后无云函数改动。tests 578 过（主会话跑）。结论：有条件 go，无严重。
抽查未回退：srvCol、ctx.safe→ctxFail、takeSlot、personkey forged、getRecord isMissing、ownCover 在 setCoverPhoto 所有写入前（books:669）。隐私弹窗组件/监听/__usePrivacyCheck__ 已全清，getPrivacySetting 仅 preflight 且有 typeof 守卫。
条目：高1 login.js:16 勾选状态存本地（privacyAgreed），退出/清数据后回到登录页默认已勾选，且不随 logged_out 清除——正是被拒原因，建议每次进登录页都不勾选；
中2 books getBook(:710) 不排除顶层 _openid 的伪造礼簿，v3.83.3 dropCover 只认 covers/ 前缀后，伪造礼簿 coverPhoto 指向别人照片→移除/改白事即可删他人文件（前提 books 集合客户端可建；修 getBook 加 !b._openid，trash.filesOf 同理）；
中3 宾客 pay 页收集姓名无任何隐私说明入口（不要用「提交即同意」措辞，建议加说明+链接）；中4 隐私说明「相册选图用于上传收款码」未含封面照片/头像，「仅主家和宾客本人可见」不准（记账人/家人也可见）；
低：booktheme 核对 is=false 但首个请求仍在服务端执行→删掉已保存照片；save 改白事与 setCoverPhoto/export coverOverride 并发→孤儿文件或悬空 fileID；clerk 同一 fileID 挂两家礼簿后一方删除；askAgree 弹窗无阅读入口；nickname input type 动态切换待真机；login 云函数不记录同意时间/版本。
下次从 5480a65 增量。
- 已修 dcdf346 v3.84.2（§240，用户确认 H1/M2-A/M3/宾客首页入口/勾选点击区/M1）：登录页始终不勾选（删 utils/privacy.js）、pay 登记页与宾客首页隐私链接、privacy.js 正文核对、提审文档第二节表格同步、getBook !b._openid、trash.filesOf 排除伪造封面。tests 587 过，preview ✔。**books、warmer 部署被 auto mode 拦截，未部署**。books.list(:95) 仍不过滤 _openid（只影响显示，未改）。下次从 dcdf346 增量。
