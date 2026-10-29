---
name: content-security-v3710
description: v3.71.0 内容安全审核（secure.js，msgSecCheck/imgSecCheck，失败放行）与宾客等待页轮询退避；覆盖清单与控制台待办
metadata:
  type: project
---

v3.71.0（commit fb5b553）已实现：tools/cloud-shared/secure.js 同步到 account/books/login/payment；只送审有改动的字段；图片 >1MB 跳过；errCode 87014 才算图片违规；任何异常/-604101 放行。覆盖清单见技术文档 §200。
**Why:** 个人主体，提审要求用户输入内容有安全检测；收款码不能走异步 mediaCheckAsync（需推送回调、先入库后追删）。
**How to apply:** 新增“展示给他人的文本/图片”入口时调用 S.checkText / S.checkImage；控制台需手动开启 security.msgSecCheck/imgSecCheck 云调用权限（CLI 不应用 config.json openapi）。pay 页轮询在 utils/paypoll.js（3s/5s/10s，最长 10 分钟）。
测试 helpers 的假库不展开 `_.set`，测“未改动不送审”要直接播种已存模板。
