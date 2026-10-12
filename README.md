# 扫码智能记账打印系统

微信小程序（原生）+ 微信云开发 + BLE 蓝牙 ESC/POS 打印。技术方案见 [docs/技术开发文档.md](docs/技术开发文档.md)。

## 功能

- 登录注册（openid 静默注册 + 昵称头像）
- 绑定个人微信收款码，生成收款专属小程序码
- 付款方扫码 → 填写姓名（必填）/金额（必填）/备注（选填）→ 登记账目 → 长按收款码完成转账
- 账目列表 + 按日/全部汇总、搜索、作废
- 蓝牙连接热敏打印机，按自定义模板打印收款小票
- 打印格式自定义：字段增删排序、标题/致谢语、纸宽、分隔线，实时预览

## 目录

```
docs/技术开发文档.md      # 技术方案（先读这个）
miniprogram/              # 小程序端
  pages/                  #   页面（index/records/printer/mine/login/account/qrcode/pay/printset）
  utils/                  #   request/escpos/ble/printer/gbk(编码表)
cloudfunctions/           # 云函数：login / account / payment / records / printtpl / qrcode
```

## 快速开始

1. **导入项目**：微信开发者工具 → 导入本目录，填入你的 AppID（`project.config.json` 中 `appid`，当前为测试号占位 `touristappid`）。
2. **开通云开发**：工具栏"云开发"→ 创建环境，记下环境 ID。
3. **建集合（自动）**：部署 `init` 云函数后调用一次即可自动创建全部集合：控制台 → 云函数 → `init` → 云端测试；或前端临时调用 `wx.cloud.callFunction({ name: 'init' })`。
4. **部署云函数**：右键 `cloudfunctions/` 下每个目录 → "上传并部署：云端安装依赖"（共 7 个：init/login/account/payment/records/printtpl/qrcode）。
5. **编译运行**：登录 → 绑定账户（上传收款码截图）→ 生成收款码 → 另一微信号扫码付款 → 账目页打印。

## 注意

- **测试号限制**：测试号无法调用 `wxacode.getUnlimited` 生成小程序码，收款码页会自动降级为"个人收款码 + 转发分享"模式，正式 AppID 下正常生成。
- **打印机**：仅支持 BLE 蓝牙热敏打印机（58/80mm，ESC/POS 指令集）；中文用 GBK 编码（`utils/gbk-table.js` 已内置 GB2312 常用区 7478 字）。
- **资金流**：系统只登记账目，实际转账走微信个人收款码，不触碰资金（详见文档 §1.2、§6.4 升级路径）。
