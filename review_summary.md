# 慧礼记代码审查报告

- 审查日期：2026-10-22
- 代码基线：`2be49ad`（分支 `hlj_agent_op`，版本 3.31.2）
- 审查范围：数据安全、云端稳定性、前端功能与 UI 兼容、打印与性能，共四个方向
- 说明：各方向的问题汇总后去重，按处理优先级排列。标「✔」的已对照代码确认属实。本次审查未修改任何代码。

**总体结论：**
- 权限模型做得扎实：账目类接口都用主家的 openid 查询，逐项校验了权限，用户传入的 id 都经过校验，没有发现越权读写别人账本的问题。
- 主要风险集中在四处：
  - 回收站搬运、批量写入、清除等多步操作的中途失败会留下错乱数据；
  - 匿名宾客端可以被滥用；
  - 打印没有并发控制；
  - 前端轮询产生的云调用量偏大。

---

## P0：建议尽快修（会造成数据错误或安全问题）

| # | 问题 | 位置 | 方案 |
|---|---|---|---|
| 1 ✔ | **删礼簿搬运中断会留下孤儿记录**：先删了礼簿文档，记录分批搬运；中途关掉小程序后，剩余记录永久留在 `records`。礼簿列表看不到它们，但人情往来、导出、备份仍会统计。warmer 只清理状态为 `done` 的条目，不会续跑 | `tools/cloud-shared/trash.js:44,88` | warmer 每小时续跑超过 10 分钟仍是 `moving`/`restoring` 的条目；另写一次性修复脚本，清理已经存在的孤儿记录 |
| 2 ✔ | **「彻底删除」没等搬运完成就执行** | `cloudfunctions/books/index.js:352` | 检查 `moveToTrash` 的返回值，没搬完就返回 `{done:false}` 让前端再调一次 |
| 3 ✔ | **打印机指令注入**：宾客填的姓名和备注里的控制字符原样发给打印机，可以触发切纸、重置，或打开钱箱 | `cloudfunctions/payment/index.js:239-242`、`miniprogram/utils/gbk.js:8` | 服务端剔除 `[\x00-\x1f\x7f]`；`gbk.encode` 对小于 0x20 的字节（`\n` 除外）也替换为空格，两道防线 |
| 4 ✔ | **记账人能清掉本场收款码，绕过主家确认**：传空串时两个分支都被跳过，直接写库。机构版里宾客的钱会转到机构自己的码 | `cloudfunctions/books/index.js:206-221` | 非主家传 `''` 时删除这个字段，或直接报错 |
| 5 ✔ | **打印没有串行锁**：礼台连续登记、批量确认时，两张小票的字节交错写入，打出乱码 | `miniprogram/pages/cash/cash.js:126`、`miniprogram/utils/printer.js` | 在 `printer.js` 里加一个模块级 Promise 队列；`ensureConnected` 也放进队列里，并对进行中的连接请求去重 |
| 6 ✔ | **头像存的是本地临时路径**（`wxfile://tmp`）：别人看到的头像全部打不开，换设备后本人也打不开 | `miniprogram/pages/login/login.js:12` | 先 `wx.cloud.uploadFile` 上传，再把 fileID 存库 |
| 7 | **清除时吞掉所有错误**：网络或限流失败也算成功，注销后礼金记录可能残留 | `tools/cloud-shared/purge.js:71` | 只忽略「集合不存在」的错误码 -502005；accounts、users 最后删 |
| 8 | **管理员备份会静默缺数据**：每个集合的查询失败时当作空数组，超过 1 万行就截断，随后照常执行清除 | `cloudfunctions/export/index.js:720,772`；`cloudfunctions/system/index.js:184`（超时 30 秒，比 export 的 60 秒短） | 任何一项失败或截断就报错；system 的超时调到 60 秒，或改为异步轮询 |

## P1：重要（正确性、滥用、稳定性）

### 宾客端滥用
- 限流是先读再写，并发请求就能绕过。宾客可以刷「现金」类待确认记录，还会刷光主家的订阅推送次数（`payment/index.js:97-105,389-472`）。
  - 方案：用 `_.inc` 原子计数，按「付款人 + 礼簿」和「礼簿全局」两个维度限流；同一礼簿内每人待确认的条数设上限；推送合并节流。
- 同名检查的配额同样可以并发绕过，可能被用来探测「某人是否随过礼」（`payment/index.js:105,120-121,192-207`）。

### 数据一致性
- 礼簿合计 `statFen` 在批量写入部分失败、更新状态后超时、回填中断时会永久不准，而且没有自愈路径（`payment/index.js:265,367,658`；`books/index.js:162`）。
  - 方案：列表接口定期用聚合校正；回填改为先算后写。
- 礼台登记和宾客随礼没有幂等键。前端的 `saving` 锁只能挡连点，挡不住网络超时后的重试（`payment/index.js:68-185,292-374`）。
  - 方案：前端生成 `clientReqId`，服务端用它派生记录 `_id`，靠主键冲突去重。
- `resolveCtx` 查询失败时会退化成别的身份，「自己是主家、同时也是别人的记账人」的用户可能把账记进自己的账本（`tools/cloud-shared/ctx.js:46-53`）。
  - 方案：三条主查询失败时直接报「请重试」。
- 导出、列表按 `createdAt` 加 `skip` 分页，而批次录入的记录时间戳完全相同，可能重复或漏行；备份的 `fetchAll` 根本没有排序（`export/index.js:254,776`、`records/index.js:373-376`）。
  - 方案：加第二排序键 `_id`，或改用游标分页。
- 以下几处都是先查再写，并发时会产生重复文档：`acceptInvite`、`account.save` 首次创建（`account/index.js:211,474-541`）。重复的成员记录会导致主家「移除」后对方仍保留权限。
  - 方案：用固定 `_id`，如 `aid_openid`、`acc_openid`。
- 整体移交时没有迁移回收站，新主家看不到回收站里的礼簿，15 天后会被直接清理（`account/index.js:605-639`）。
  - 方案：迁移时把 `trash_books`、`trash_records` 一并转到新主家名下（`trash_books` 同时更新 `aid`）。

### 权限旁路（记账人越过主家）
- 记账人能直接扩大家人可看的礼簿范围，不经主家同意（`account/index.js:952`）。
- 记账人能移除待同意的申请，相当于代主家拒绝（`account/index.js:841`）。
- 记账人能改权限比自己大的成员的记账名称（`account/index.js:881`）。
- 只读家人能看到全部记账人信息（`account/index.js:790`）。
- 导出的临时文件清理在权限检查之前就执行了（`export/index.js:70`）。

### 前端功能
- 「记回礼」一点就把提醒标为已处理，没有等保存（`pages/renqing/renqing.js:172`）。
  - 方案：带上 `remindId` 跳到 giftedit，送礼记录保存成功后再标记。
- 右上角「转发」会把记账人邀请卡发出去（`pages/members/members.js:358`、`pages/bookshare/bookshare.js:55`）。
  - 方案：`res.from !== 'button'` 时返回首页路径。
- 编辑礼簿时如果加载失败，保存会变成新建一本（`pages/bookedit/bookedit.js:38`）。
  - 方案：带了 `options.id` 却没加载到时，显示错误和重试，禁止保存。
- 打印中途失败会整单重发，打出一张残票加一张完整票（`utils/printer.js:89`）。
  - 方案：只在第一包就失败时整单重试；中途失败提示「请检查小票后补打」。
- 批量确认后逐张打印时没有任何提示，打印失败也不报告（`utils/confirm.js:111`）。
  - 方案：显示「打印 i/N」进度，结果弹窗里报告失败张数。

### 大数据量
- 传统样式 PDF 导出用了 `bufferPages`，并且逐字绘制，1 万笔时容易超时或内存爆掉（`export/index.js:345,491,630`）。
  - 方案：设单独的上限，或分段导出；内存调到 512MB 以上。
- 人情往来每次请求都全量重建，单次请求最多约 90 次数据库查询；`buildPersons` 是 O(n·m) 的复杂度（`renqing/index.js:281-305,355`）。
  - 方案：单次查询 limit 用 1000，并改用 Map 查找。
- warmer 超时只有 20 秒，但里面串行执行推送、回收站清理和预热（`warmer/index.js:138-166`）。
  - 方案：超时调到 60 秒，各阶段设时间预算。

## P2：性能与体验

### 云调用量
- 礼簿页、工作台、待确认页每 5 秒全量轮询一次，而且无论数据变没变都 setData，网络慢时请求还会叠加。停留一小时约 720 次调用（`pages/records/records.js:103,157-178`、`pages/index/index.js:89,168-176`、`pages/pending/pending.js:55,66-90`）。
  - 方案：改为轮询轻量的 `pendingStat`；数据没变就跳过 setData；加防重叠标志；无变化时退避到 15–30 秒。
- 工作台、往来页每次切回来都全量拉取（`pages/index/index.js:84`、`pages/renqing/renqing.js:29-43`）。
  - 方案：加 30–60 秒的节流，并先显示缓存。

### 包体
- 34 个页面全部在主包，主包约 1.4MB，接近 2MB 上限（`app.json` 没有 `subpackages`）。
  - 方案：低频页面拆分包，例如 admin、reconcile、export、trash、打印相关。
- 打开「礼簿」tab 时，261KB 的 `gbk-table.js` 被同步加载。
  - 方案：在 `gbk.encode` 第一次调用时才加载；生成器改为紧凑格式。

### 打印
- 固定 20 字节分包，没有协商 MTU（`utils/ble.js:141-160`）。
  - 方案：Android 调 `setBLEMTU(185)`。
- 已连接时再次连接、切换设备时，旧连接没有关闭（`utils/ble.js:69-85`）。
- 蓝牙错误码没有区分，蓝牙关闭、未授权、定位未开都提示成同一句话（`utils/ble.js:16-34`、`utils/printer.js:43-53`）。
- 搜索设备没有超时（`pages/printer/printer.js:37-53`）。
- 模板拉取失败后，默认模板被永久缓存（✔ `utils/printer.js:27`）。
- GBK 表外的字符（生僻姓名、emoji）静默打成「?」（`utils/gbk.js:15`）。

### 数据库索引
在控制台补建，也可以加进 `system/index.js` 的 INDEXES：
- `records(ownerOpenid, payerName)`
- `records(ownerOpenid, status, bookId, createdAt)`
- `trash_records(ownerOpenid, bookId)`
- `trash_books(trashStatus, purgeAt)`
- `reminders(done, pushed, subscribed, remindAt)`
- `members(aid, status)`
- `person_alias(ownerOpenid)`

## P3：小问题，集中处理一批即可

### 列表与提示
- 「送出的礼」只显示 50 条；待确认页只显示 100 条；提醒允许存 200 条但只返回 100 条（`renqing.js:77`、`records/index.js:429-431`、`renqing/index.js:103,149`）。
- 宾客等待超过 10 分钟后，页面仍在转圈（`pages/pay/pay.js:260-263`）。
- 分批删除没删完也提示「已移入回收站」（`pages/books/books.js:138`）。

### 交互细节
- 清空搜索框后列表不恢复（`pages/records/records.wxml:20`）。
- 礼台记账页先选同名宾客，最后才检查是否选了礼簿（`pages/cash/cash.js:107-109`）。
- 待确认页的确认按钮默认显示，权限确定前会闪一下（`pages/pending/pending.js:31`）。
- 校正金额的弹框打开时，从后台回到前台会恢复轮询（`pages/pending/pending.js:45-56`）。

### 输入与显示
- 金额输入框是文本键盘，输入「1,000」会报错（`utils/confirm.js:39-54`）。
- 主家称呼没有长度限制，台卡上的长名字会超出画布（`pages/account/account.wxml:24`、`pages/qrcode/qrcode.js:229`）。
- 批次名单的 `wx:key` 写错了（`components/batch-list/index.wxml:2`）。

### 状态与缓存
- 快速离开礼簿码页时，屏幕亮度可能不恢复（`pages/qrcode/qrcode.js:134-151`）。
- 工作台的「打印机 已连接」只表示配对过，不是真的连着（`pages/index/index.js:99-100`）。
- 对账页快速切换礼簿时，旧请求的结果可能覆盖新的（`pages/reconcile/reconcile.js:35-60`）。
- 若干变更接口没有清 `dashboard` 和 `rec_*` 缓存（`utils/request.js`）。
- 读取身份失败时页面按有权限处理，进得去礼台记账、礼簿码页（`app.js:105-115`）。
- 确认入簿的成功提示被「打印机未连接」提示顶掉（`utils/confirm.js:63-66`）。

### 安全加固
- 人情往来标识的加密密钥写在代码里，IV 固定为全零（`renqing/index.js:17`）。
  - 方案：密钥移到环境变量，或改用 HMAC 加映射表。
- 部分读记录的查询没有加 `_openid` 不存在的过滤条件（`payment/index.js:672-679`、`records/index.js:191,395,503`）。
- 移交卡是「持有即可用」，转发泄露后第三方能接收整个主家（`account/index.js:412-427,557`）。
- qrcode 函数把底层错误原样返回给前端（`qrcode/index.js:242`）。
- printtpl 函数没有校验 OPENID（`printtpl/index.js:112-116`）。

### 并发写入
- 回收站搬运每批 100 路并发写，warmer 推送 50 路并发，容易触发数据库限流（`trash.js:19`、`warmer/index.js:197-210`）。
  - 方案：分成每组 10–20 个的小批次。

### 需要在控制台或真机确认
- 订阅消息在 `await` 之后才调用，可能被微信拒绝（`pages/records/records.js:278`）。
- 昵称输入只绑了 `bindinput`，部分 Android 机型点选微信昵称时可能取不到值（`pages/login/login.wxml:20`）。
- 打印机是否需要发 `FS &` 才进入汉字模式（`utils/escpos.js:9`）。
- export 定时器触发的时区，确认实际是北京时间 3 点还是 11 点（`export/config.json`）。

---

## 已核实没有问题的点

- 金额校验：NaN、负数、上限都做了校验。
- 状态流转：使用带条件的原子更新；合计计数器用 `_.inc`。
- 返回前端的数据经过 `strip`/`shown` 处理，去掉了 openid。
- 收款码文件必须是本人上传的路径；AppSecret 从环境变量读取。
- warmer、export 的定时分支无法被客户端冒充；各函数 `main` 的 `__warm` 早返回正确。
- 日期按北京时间计算，没有发现时区 bug。
- 非 tab 页底部操作栏都已加 `env(safe-area-inset-bottom)`；原生 button 样式覆盖写法正确。
- 窄屏下长姓名、大金额都做了省略或缩小字号。
- 定时器在 onHide/onUnload 里都已清理；扫码参数做了 `decodeURIComponent`。

## 建议的版本拆分

1. **v3.32.0（数据安全与一致性）**：P0 全部 8 条，加上记账人权限旁路那 5 条。云函数改动集中在 trash、purge、books、payment、account、export、warmer。
2. **v3.33.0（防刷与幂等）**：原子限流、`clientReqId` 幂等、合计校正、固定 `_id` 去重、补建索引。
3. **v3.34.0（性能与体验）**：轮询降频、分包、gbk 表懒加载、打印 MTU 和错误提示，以及 P1、P3 里的前端问题。
