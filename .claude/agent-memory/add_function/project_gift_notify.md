---
name: project-gift-notify-default-off
description: v3.66.3 新礼金微信提醒改为默认关闭、按人在高级功能开启（方案B，用户已确认）
metadata:
  type: project
---

v3.66.3（提交 5c4ad35，未上传）：users.giftNotify（缺省关）、account.setGiftNotify、account/records 返回 giftNotify、notifyOwner 名单缓存里按 giftNotify 过滤，空名单直接 return；前端 notify.setGift/giftOn/tipText(lastNotify, gift)、advperm.giftItem、高级功能页新卡片。
**Why:** 宾客点完成转账时构造并发送模板拖慢返回，多数人不需要。
**How to apply:** 改提醒相关逻辑时记住：未开启的人不续订、不显示提示条；部署需 account、payment、records 三个函数；自动模式分类器曾拦截 CLI 部署，需用户手动部署。
