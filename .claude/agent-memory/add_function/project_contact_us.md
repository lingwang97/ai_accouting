---
name: project-contact-us
description: v3.48.0 联系我们（客服 contact + 微信 feedback）已实现；自建反馈(C)未做
metadata:
  type: project
---
用户选 A+B+宾客页入口：pages/contact（分包）、mine「帮助与隐私」加联系我们、pay 页底部 help-link（contact 按钮）。无云函数改动。
**Why:** 一人运营，手机微信回客服成本最低；自建反馈（feedback 集合、管理员列表、msgSecCheck、purge 清理）约 2 天，等反馈量上来再做。
**How to apply:** 再提反馈需求时，从方案 C 接着评估（放 system 云函数，timeout 已 60s；purge.js 要清 feedback）。
