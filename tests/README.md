# 自动化测试

运行：`node tests/run.js`（一条命令跑完全部；任一失败退出码为 1）。只用 node 原生 `assert`，不引入依赖；
没有网络、不连云环境，云函数用 `tests/helpers/sdk-stub.js`（假的 wx-server-sdk）+ `tests/helpers/fakedb.js`（内存数据库）加载。

提交 / 上传前建议：`python tools/sync_shared.py --check && node tests/run.js`。

| 文件 | 覆盖 |
| --- | --- |
| `ctx.test.js` | 身份权限矩阵：主家 / 全权记账人 / 部分礼簿记账人 / 非机构模式 / 家人共享 / 待同意 / 伪造 `_openid` / 无身份 × `can`、`canBook`、`readonly`、`restricted`、`workBook`；礼簿短码长度；`account.wider` |
| `actions.test.js` | 前端 `request.js` 调用的每个 action 在云函数里都有处理；`READ_ACTIONS` 无拼写错误、不含写操作；payment 的 `OWNER_ACTIONS` 与 `NEED` 一致 |
| `records.test.js` | `records.list` 查询条件（状态筛选、排序白名单、分页上下限、礼簿范围、关键词 `and` 组合）；待确认页三类的状态与 3 分钟 / 24 小时阈值；`expirePending`（30 分钟） |
| `collections.test.js` | `collections.js`（init / system 共用）、purge 清除目标、代码里用到的集合三者一致；purge 条件只限本人 |
| `shared.test.js` | `status.js` 常量取值与阈值、`isToConfirm`；`common.js` 的 ok/err 与北京时间（含与旧算法 5000 组随机时间逐一比对）；云函数目录里相对 require 的文件齐全；云函数 / 小程序 js 里不再有写死的状态字符串 |
| `fonts.test.js` | 导出字体加载：下载成功 / 失败 / `/tmp` 已缓存 / 缓存损坏 / 未上传 / 文件损坏 / 并发；黑体失败报错，宋体、毛笔失败回退黑体并提示，囍水印回退；export 包内不再有字体数据 |
| `export.test.js` | export 端到端（需 pdfkit、exceljs，没装会跳过）：表格 PDF、三种字体的传统礼簿、字体下载失败回退、存档不回退、字体未上传时 PDF 提示 / Excel 与备份照常、定时清理不加载字体。本地跑：`npm i pdfkit exceljs`（任意目录），`NODE_PATH=<目录>/node_modules node tests/run.js` |
