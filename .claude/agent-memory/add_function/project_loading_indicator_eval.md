---
name: loading-indicator-eval
description: 加载提示需求（v3.25.0 已实现，方案 A）：components/loading 组件用法、接入页面、注意点
metadata:
  type: project
---

用户选择「一A 二加 三混合 四0.3秒」，v3.25.0 已实现并本地提交（c8ae6cb），未上传。

实现要点：
- 组件 `miniprogram/components/loading`（show/type/text/rows/delay；type=skeleton|spinner|overlay；show 为真超 300ms 才显示；overlay 一开始就透明拦截触摸）。颜色用页面 themeStyle 的 --primary。
- 全局 `.sk` 骨架基类放在 app.wxss；index/records 已去掉私有副本。
- 列表页用 skeleton（条件一律「loading && 无数据」，轮询/下拉/缓存刷新不触发）；表单页用 overlay + pageLoading（account/printset/receiptset/cash/export/admin）；bookdetail/pending 用 block wx:if 包住。
- giftedit/remind/appearance 数据来自本地 globalData，无云端加载，未接入。
- renqing：loading 初值改 true，onTab 同步置 loading:true，退出登录/未登录分支置 false。

踩坑：
- `<loading>` 不能插在 wx:if / wx:elif / wx:else 链中间（bookdetail 因此编译失败）；链内用 `<block wx:if><loading show="{{true}}"/></block>`。
- cli preview 失败信息要用 grep -v "at " 过滤后看 message；成功必须有 ✔ preview。
- 页面 loading 标志要放 finally 里关闭。

How to apply: 以后新页面有首次云端加载，直接复用该组件，不要再写私有骨架。
