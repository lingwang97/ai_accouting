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
