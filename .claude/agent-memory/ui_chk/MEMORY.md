# ui_chk 记忆

## 2026-10-21 检查 v3.24.1（只读检查，未改代码）
已核实仍生效（别再报）：app.wxss:61-64 的 button.btn / 颜色变体整行宽覆盖；qrcode 分享按钮 width:auto；cash 已登记列表省略；mine 用户卡片省略；members 弹层 ed-list 38vh；renqing 提醒行省略；pending 逐笔大字 word-break；切换身份 pickIdentity 分页（<=6 项）。
modal confirmText/cancelText 全部 <=4 字；success 图标 toast 全部 <=7 字；showActionSheet 项数均已控制在 6 以内；全项目无 flex gap。

本次问题：
- U1 P1 records.wxss:27 `.r-actions .btn{margin-left}` 权重 (0,2,0) 输给 app.wxss:61 `button.btn:not([size=mini])` (0,2,1)，待确认栏「未收到/确认收到」两按钮贴在一起
- U2 P2 records 已入簿行（badge x2 + 4 个链接）总宽约 568rpx，360dp 安卓放大字体/窄屏溢出卡片（作废被挤出）
- U3 P2 books.wxss:32 b-foot 左侧金额+右侧 4 个操作（约 408rpx）在 375pt 下金额会折行
- U4 P2 trash.js:75 彻底删除 editable 弹窗只把礼簿名放在 placeholder，名称长被截断看不全
- U5 P2 pay.wxss:51 三步 sr-item nowrap + flex:1，360dp 及以下或大字体会溢出卡片
- U6 P3 .container 无底部安全区（非 tab 页：trash/setup/start/guide/pay/cash/members 等）；qrcode .screen 同
- U7 P3 qrcode s-op 三按钮大字体折行；guide m-tile nowrap 窄屏溢出；index guide-close 点击区 56rpx 偏小；pending .stall-row:first-of-type 永不匹配；members 编辑弹层小屏需滚动才见「保存」

## 反复出现的坑
1. 给 `<button class="btn ...">` 设 margin 必须写成 `button.xxx:not([size=mini])`，否则被 app.wxss:61 的 margin-left/right:0 压掉（`.a .btn` 权重不够；`.a .btn:not(:last-child)` 权重 (0,3,0) 才够）。
2. 一行多个 nowrap 的链接/徽章/按钮（records 已入簿行、books b-foot、pay step-row）在 360dp+大字体下溢出，应允许 flex-wrap 或拆行。
3. 非 tab 页的 `.container` 没有 env(safe-area-inset-bottom)。
4. rpx 在 iPad/PC 放大，弹层里 scroll-view 的 max-height 用 rpx 在横屏/矮窗会与 sheet 的 92vh 嵌套滚动。

## 待真机确认
catchtap="" 空绑定（index.wxml:31 !canSwitch 时）是否仍阻断冒泡；鸿蒙 NEXT 的 `<image>` 加载 svg 底部菜单图标；pending 弹层在 iPad 横屏；editable showModal 在 PC/鸿蒙 NEXT 的表现；app.json 无 resizable / darkmode。

## 已修复 v3.24.2（U1-U11 全部）
records r-op margin、r-actions 换行；books b-foot 换行；trash 彻底删除两步弹窗；pay sr-item 可断行；.container/qrcode 安全区；qrcode s-op nowrap；guide m-tile 可断行；index guide-close 80rpx；pending stall 间距；members 弹层按钮固定底栏。别再报。

## 2026-10-25 检查 v3.59.2（只读，未改代码）
已核实无问题（别再报）：modal 按钮字数、success toast 字数、actionSheet 项数均合规；无 flex gap；wx.getBLEMTU/setBLEMTU 有 typeof 兜底；printer/index 打印机三态 + onStateChange 订阅与 off 正常；canvas 2d 离屏 1:1 无 dpr 放大；资产文件无缺失。
本次问题（编号 V1-V12，详见报告）：
- V1 P1 records.wxml:91 amend 弹层 `.mask` 没用 renqing 的 tab-mask 方案，底部「取消/保存」被自定义 tabBar 盖住（tabBar 无 z-index 但在页面之上）。
- V2 P2 receipt 页无加载态（空白）；reconcile .row 右侧金额可换行；printer dev-row/mine 蓝牙行设备名过长挤压；renqing 弹层小屏嵌套滚动；printset 长文案行窄。
- P3：硬编码色（#FF9F1C/#FA9D3B/#D46B08/#f5222d/#d93025，bell-r.svg 红色图标，booktheme switch #07C160，loading 组件 #C8161D），点击区小（bc-switch-btn 64rpx、pv-tab、色块 56rpx）。

## 已修复 v3.59.3 - v3.59.5（V1-V12 全部，iPad/PC 最大宽度主动跳过）
v3.59.3：records 修改弹层改 tab-mask；receipt 加载态；reconcile/printer/mine 长文字。v3.59.4：renqing 弹层收缩、printset 排版与 80mm 预览、点击区放大、白事回执素灰、avatar-btn 选择器。v3.59.5：app.wxss 加 --warn 系列统一橙色；theme.apply 写 themeIcon/themePrimary；bell-{d,n,y,b,k}.svg。别再报。
提交注意：commit 署名用系统提醒给的 Sonnet 5.5。

## 2026-10-27 检查 v3.64.1 并修复 v3.64.2 - v3.65.0（别再报）
v3.64.2：advanced 开关复位改 resetSwitch（先写翻转值再写回，否则 switch 视图不刷新）；canvas 标题 fitTitle；advanced planReady 加载态；trash days 初值 0。
v3.64.3：receipt.fixForBook 白事校正版式/主色；buildModel premiumOpen 降级；寿字水印居中、商务顶栏 150；会员标签只在锁定显示；--line 变量（其余页面仍写 #f5f5f5）。
v3.65.0：index 高峰模式提示条 + 每分钟刷新；advperm.peakLeftText。
新坑：switch 取消/失败复位必须强制刷新；白事红色印章未处理（用户可自行关）；待真机：switch 复位、canvas 5 种版式、鸿蒙 NEXT。
提交署名用系统提醒的 Sonnet 5.5（主会话曾写 Opus 5.5，以系统提醒为准）。

## 2026-10-27 检查 v3.66.5（只读，未改代码；f031afb..HEAD 增量 + 全页复核）
已核实无问题（别再报）：新增 modal 按钮字数均 <=4；net-bar/peak-bar 在 index 同文档流堆叠不重叠；requestSubscribeMessage 在 pay 的 tap 首个 await 前；wx.cloud.downloadFile/getFileSystemManager 基础库 2.21.2 均支持；index neterr 态与 tabBar 留白正常。
本次问题（W 编号）：W1 pending/records 轮询失败时 net-bar 与 net-err 同时出现；W2 advanced giftOn 默认 false 未用 notify.giftOn() 缓存预置，弱网时显示成关；W3 qrcode 离线副本无收款码时第 2 步空白；W4 pay.js:187-189 toast 未随白事用词（随礼人/礼金）；W5 books.js 删除/归档弹窗、mine.wxml:17 机构模式仍说记账人/礼簿；W6 pay.js:140 仍用主色 setNavigationBarColor（funeral 灰 + 白字需确认）；W7 cash 自动聚焦后键盘遮挡已登记列表，iOS focus 待真机。

## 2026-10-28 全面检查 v3.67.0（只读，未改代码，编号 X1-X14）
已核实无问题（别再报）：modal 按钮字数/success toast/actionSheet 项数全合规；无 flex gap；资源图标无缺失；canvas 1:1 无 dpr；admin.wxs 为 ES5；底部 bottom-bar 留白均够；members 弹层固定底栏仍在；records/renqing tab-mask 仍在。
本次问题：X1 头像存的是 chooseAvatar 临时路径（login.js:16/32，云函数只存字符串），重启/他人设备全灰圆；X2 guide.js:buildFaq `open: !!(kw||...)` 搜索时点分类/问题折叠无效，宽词全展开；X3 pending/members/bookshare 的 .mask 缺 catchtouchmove（records/renqing 有）→ 背景滚动穿透；X4 app.json backgroundTextStyle=light 且无 backgroundColor，records/pending/reconcile/orgsummary/myreceipts 下拉刷新点点看不见；X5 mine.wxml:68 回收站「保留 15 天」写死（会员可选 30/60）；X6 login nickname 只绑 bindinput（待真机：快捷填入后立即点登录是否取到值）；X7 admin.wxss:3 `.row .btn` margin 被 button.btn:not([size=mini]) 压掉（搜索按钮贴输入框）；X8 orgsummary r-name/st-row 无省略；X9 books/members/cash/index/reconcile/export 机构模式仍用「礼簿/记账人/当前礼簿」；X10 cash 页白事仍「随礼人」「💵」，pay 失败页 ❌/⚠️/📷 emoji；X11 FAQ answer break-all 切英文词；X12 login/invite/myreceipts 未调 setNavigationBarColor（白事灰内容配红导航）；X13 硬编码色 #B8860B/#FFD591/rgba(255,159,28)/#d94c4c/#f0b429 未走 --warn；X14 reconcile 画布高度随 handlers 无上限。

## 已修复 v3.67.1 - v3.67.3（X1-X14 全部，别再报）
v3.67.1(70f34b6)：FAQ 搜索态可收起(前5条展开)、pending/members/bookshare 遮罩 catchtouchmove、backgroundTextStyle dark、mine 回收站副标题、admin 按钮间距、orgsummary 省略。
v3.67.2(28e1513)：头像上传云存储(utils/avatar.js)+mine 点头像重选+binderror 回落；昵称 bindblur；utils/orgtext.js/.wxs 机构用词；白事 cash 致奠人、去 emoji。
v3.67.3(5f6b407)：FAQ 长答案分句+pre-wrap；theme.applyNav；警示色变量；reconcile 图 70 行上限(format.clipLines)；点击区；invite placeholder。
坑：在 bash 里用 python heredoc 写含反斜杠的字符串会被吃掉/变真换行，要用 chr(92) 或直接 cat heredoc 写文件。提交署名用 Sonnet 5.5。

## 2026-10-29 上线前检查 v3.71.0（只读，未改代码，编号 Y1-Y9）
已核实无问题（别再报）：modal 按钮字数/success toast/actionSheet 项数全合规；无 flex gap；各页 onLoad 已调 theme.early（pay/qrcode/receipt 宾客页刻意不调）；index .page.tab-page 留白在；mock 示意图 CSS 均带省略；advanced 去掉刷新卡后布局正常；v3.71.0 违规提示=toast 17 字 icon none（可两行）；pay 等待页 pollTimeout 文案/刷新状态正常。
本次问题：Y1 index.wxss:118 `.he-btn{margin-left}` 被 `button.btn:not([size=mini])` 压掉（宾客首页「我是主家」卡文字贴按钮）；Y2 login 页无隐私说明/协议入口（隐私页只在 我的→隐私与数据，未登录进不去）；Y3 privacy.js 设备权限漏写摄像头扫码、剪贴板、内容安全检测、头像上传云存储；Y4 「联系我们开通会员」在 iOS 上有虚拟商品引导站外购买的审核风险（faq.js:157、advperm.js、request.js:39）；Y5 records.js:66/84/256 「全部礼簿」机构模式未换词；Y6 records 无礼簿时顶部 picker 显示「全部礼簿 ▾」+「暂无礼金记录」引导弱；Y7 mine 头像可点但无提示；Y8 advanced.wxss 残留 .a-opt 等刷新档死样式；Y9 records.wxml:91 首次加载骨架与「加载中…」同时出现。

## 2026-10-30 上线前检查 v3.74.3（只读，未改代码，编号 Z1-Z8）
Y1/Y2/Y5 已确认修复（he-btn、login 隐私说明、records 机构换词）。modal/toast/actionSheet 字数项数合规，无 flex gap，my-gifts 为 apply-shared 样式生效。
问题：Z1 v3.74.3 去掉「我的」随礼记录入口后，机构模式主家/记账人(往来 tab 被 hideOrg/hideClerk 隐藏)没有任何入口看随礼记录；Z2 my-gifts 区块标题「主家未确认收到」/kept 文案白事未换词；Z3 index 工作台宫格 g-sub 单行省略，「N 份 ￥X · 申诉 M」大金额/大字体会截掉申诉数；Z4 my-gifts 首次加载 empty 初值 false，骨架屏永不显示；Z5 receipt 加载中灰色主题，喜事先灰后红；Z6 admin pf 手动项算入 warn；Z7 renqing 随礼记录栏无下拉刷新；Z8 pay 失败页文案较长。

## 2026-10-30 最后上线前检查 v3.76.0（只读，fff5af5..HEAD 增量，编号 A1-A5）
结论：可上线，无必须修。Z1-Z8 修复未回退；modal/toast/actionSheet 合规；无 flex gap；pending sheet 遮罩有 catchtouchmove，下拉刷新不会穿透。
问题（均 P3）：A1 pay.js askDup 的状态文案对现金随礼写「还没点我已完成转账」不贴切，且「礼金」白事未换词；A2 busyTip 弹窗与 request.js 默认 toast 同时出现，且 content 里「请稍等几秒再试。请过几秒再点」重复；A3 pay 等待页「下拉可立即刷新」在超时态也显示、无样式；A4 pending name-row 在 320 宽+大字体+现金+疑似重复+批次时标签挤压姓名（姓名保底 2em）；A5 index/pay 下拉刷新真机待确认。
已修复 v3.76.1(93e41ea)：A1 askDup 现金/白事文案；A2 payCreate silent + busyTip 固定文案，非限流错误经 req.showErr 仍提示。复查 v3.76.1：无新问题，A3-A5 留待上线后；待真机：限流弹窗、现金限流、白事 dup 弹窗。别再报 A1/A2。

## 2026-11-01 上线前检查 v3.78.5（只读，93e41ea..0f642b9 增量 + 抽查，编号 B1-B8）
已核实无问题（别再报）：modal 按钮字数/success toast/actionSheet 项数合规（家人共享 switchViewerBook 最多 6 项）；无 flex gap；filter/sort/share-m/swap-m 图标齐全；transfer 页有 theme.early、非主家有拦截；pending 其他礼簿申诉/未收到折叠逻辑正常；mine 分组卡片无空卡；登录页隐私入口仍在；用户决策（联系我们开通会员、移交主家副标题）未动。
问题：B1 records 状态四段 seg-item nowrap+flex:1，筛选行右侧排序按钮 flex-shrink:0，小屏/大字体「待确认」等挤出（P2）；B2 家人共享共享礼簿>6 本时，index 最后一项「共享给我的礼簿…」跳 books 页，但 books 页对 viewer 无「选看这本」入口，第 6 本以后选不了（P2，边缘）；B3 books 底栏「礼簿共享」按钮机构模式未换词；viewer 时「其他礼簿」标题未区分（P3）；B4 pending 逐笔大卡去掉了「请核对微信已收到上面的金额」提示（P3）；B5 advanced 峰值模式说明去掉「增加云开发调用量」、回收站天数说明去掉「已在回收站的按原到期日」（P3）；B6 transfer switch color 用 primary 首帧未设（P3）；B7 index.wxml empty-card 无样式（无害）；B8 records 搜索行 320 宽+大字体较挤（待真机）。

## 2026-11-01 最后上线前检查 v3.78.6（只读，0f642b9..4244da9）
增量仅 3 个前端文件：pending.wxml:179 恢复核对提示（.tip 样式在 pending.wxss:70，正常）、admin.js:26 wipeKeepAdmins 默认 false（开关 checked 同步，一致）、config 版本。modal/toast/actionSheet 复核合规，无 gap。无新问题；B1-B8 状态未变（均未修，B1/B2 P2 可上线后处理）。

## 2026-11-02 检查 v3.83.1（只读，4244da9..HEAD，booktheme 导出页 + pvfont + imgcompress + admin，编号 C1-C13）
结论：无必须修。modal/toast/actionSheet 合规，无 flex gap，booktheme 有 theme.early，底栏三按钮 26%/34%/flex 在 320 宽够用，sticky z4<底栏5<mask10，裁剪/确认面板有 catchtouchmove。
问题：C1 裁剪面板（js:521 框最高 620rpx + 九宫格 + 3 按钮）在 SE/8 等小屏超 94vh，按钮要滚动，拖照片可能带动面板滚（建议按 windowHeight 限框高）；C2 会员字体试看每点一次弹 vip.explain 模态盖住示意图（js:467）；C3 pvfont.load 失败 '' 缓存到页面结束，弱网无法重试（pvfont.js:104）；C4 机构模式漏换词：wxml:124/137「礼簿名」、186「白事礼簿」、231「记账人签名栏」、js:241 示意「记账人」；C5 cropRender 每次 touchmove 两次 setData（js:576-591）；P3：示意图小字 4-5pt、吸顶示意图占屏 38% 小屏默认可收起、点击区（pv-fold/pv-tab/crop-zb/fcell）<44pt、.chip.try 加 4rpx 边框抖动、dim-loader 无 binderror 致「照片还在加载」、imgcompress.cover 小图也二次压缩、封底落款 placeholder 过长。
待真机：loadFontFace data URI（iOS/安卓/鸿蒙 NEXT）、crop 手势与面板滚动、slider bindchanging 回写抖动、enableAlertBeforeUnload 返回提示。

## 已修复 v3.83.2 (38ec0bd)：C1-C13（C7 用户决定保持默认展开，不改）。别再报
裁剪面板按 windowHeight 限高+sticky 按钮栏；试看只弹一次；pvfont 失败不缓存；export 机构模式封底「礼台人员」/表格「场次」(orgT)；示意图 0.68 缩放；chip 透明边框；JPG<=1.5MB 不二次压缩。坑：bash 里嵌套多个 heredoc 会报 unexpected EOF，大段内容用 Write 工具写文件再执行。

## 2026-11-02 上线前检查 v3.83.2（只读，32b5dc0..38ec0bd + 全量抽查，编号 D）
C1-C13 复核均已修好（C7 用户决定保留）：裁剪框 _maxH 按窗口高度、sticky 按钮栏含安全区、cropRender 合并 setData、tryHint 只弹一次、pvfont 失败不缓存、orgT 机构换词（前端 wxml + 云函数 export）、chip 透明边框、dim-loader binderror。无新增阻断问题。
全量抽查合规：modal confirm/cancel 全 <=4 字（admin.js:506 取消订阅 4 字）；success toast <=7 字（已记入礼簿 5、已按实收入簿 6）；actionSheet 均有 6 项上限（index 超 6 取 5+更多、samename SHEET_MAX、records onMore 最多 4）；无 flex gap；除 pay/qrcode/receipt 宾客页外都有 theme.early；tab 页 padding 用 container tab-page 顺序正确；mask 弹层都有 catchtouchmove；login 隐私入口在。
剩余小项（P3）：D1 真实封面缩略图/裁剪图无 binderror（仅 dim-loader 有）；D2 export 云函数 orgT 改动需部署云函数才生效；D3 示意图小字约 9pt 仍偏小；D4 pv-tab/pv-fold 负 margin 扩大点击区可能与相邻元素点击区重叠。

## 2026-11-02 上线前检查 v3.84.1（只读，38ec0bd..5480a65，编号 E）
增量仅 login/bookedit/booktheme(云存储核对)/privacy.js/request.js。隐私弹窗组件已删干净：全项目无 privacy-popup、__usePrivacyCheck__、onNeedPrivacyAuthorization 残留（只有 privacy.js 注释）。
已核实无问题（别再报）：login 勾选框默认不勾、未同意头像 bindtap + 昵称 disabled+遮罩、modal 同意/取消、bookedit「改为白事」继续/取消，全部 <=4 字；全项目 modal 按钮字数/success toast/actionSheet 项数合规，无 flex gap；除 pay/qrcode/receipt 外都有 theme.early；mine 帮助与隐私在 user 块外，未登录也能进隐私页；app.js 启动只做 action:check 静默恢复，不注册。
问题：E1 privacy 同意标记 privacyAgreed 退出登录/清除数据后不清，再登录页是已勾状态（可能被审核员当成默认勾选）；E2 login agree-hit/agree-link 点击区约 60rpx 高 <88rpx；E3 宾客 pay 页填姓名无隐私说明入口，宾客首页无隐私入口（仅「我的」tab 有）；E4 清单见报告。
待真机：input type 由 text 动态切 nickname 是否生效；遮罩在 iOS/鸿蒙点击；微信后台「用户隐私保护指引」需与 privacy 页一致。
