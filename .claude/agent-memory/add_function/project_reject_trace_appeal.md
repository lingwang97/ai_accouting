---
name: project-reject-trace-appeal
description: v3.73.0/v3.74.0 未收到原因与追溯、宾客可见、申诉；my-gifts 共用组件；用户选 B 复用模板 1次 选填 30天 分版
metadata:
  type: project
---

v3.73.0（a7c28cf）：reject 带原因（showActionSheet 选填）+ rejectedBy + trail 日志；myReceipts 返回 rejected(30天)/cancelled(3天)+时间线；未收到通知复用入簿模板（一次订阅一条，发前先把 guestNotify 置 false）；components/my-gifts 宾客页与往来页第三栏「随礼记录」共用；「我的」页加「我的随礼记录」入口（记账人、机构模式往来隐藏时用）；索引 payer_status_rejected（共 31 条）。
v3.74.0（7184bda）：appeal（每笔1次、每人每天5次、msgSecCheck、点击时重新订阅）+ resolveAppeal（accept 走 ownerUpdate 入簿 opts.appeal；keep 终态）；待确认页「宾客申诉」栏；角标 = badge + globalData.appealN；对账 appeal 汇总；utils/trail.js 主家侧日志文字。均未上传。
**Why:** 被标未收到后宾客原先看不到任何痕迹。
**How to apply:** 不新增 status 值，用 appealStatus 字段；pendingStat 的 appeal 数 30 秒缓存（tests/v3690 限制轮询读次数）；编辑文件时工作区是 CRLF，用 edlib 式脚本（读时转 LF、写 newline LF）；bash heredoc 含特殊字符会解析失败，改用 Write 工具写脚本。
v3.77.0（438b7a0，未上传）：未收到通知改独立模板 GUEST_REJECT_TMPL_ID（thing4/time1/amount2/thing3），记录标记 guestRejectNotify 与 guestNotify 各自消耗，旧前端不发未收到；guestsub.ask() 返回 {guestNotify, guestRejectNotify}，flags(sub) 转参数；申诉跨礼簿：pendingStat.appeal=全部可见礼簿合计+appealOther，resolveAppeal 只校验 canBook，归档礼簿 accept 拒绝/keep 允许；新索引 owner_status_appeal（共 32 条，v3721 测试与提审文档同步）。
v3.77.1：新礼金提醒（notifyOwner）换模板 sVsj…（thing1/thing4/amount7/time9/thing3），前端 localStorage notify_tmpl 判断旧订阅并提示重新开启。部分文件是 CRLF（如 payment/notify.js、docs），改文件用先检测 CRLF 的 rw 脚本；bash heredoc 含撇号会失败，用 Write 写脚本。
v3.77.2（未上传）：pending 折叠 utils/foldseen.js；records.list status=rejected；礼簿页四个筛选。工作目录若变 miniprogram，harness 会生成空的 miniprogram/.claude，须删除否则测试失败。
