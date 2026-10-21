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
