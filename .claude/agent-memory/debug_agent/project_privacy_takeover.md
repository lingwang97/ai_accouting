---
name: privacy-takeover-hang
description: 不要用 wx.onNeedPrivacyAuthorization 自定义接管隐私授权，真机会让头像/昵称卡住（v3.84.0 -> v3.84.1 回退）
metadata:
  type: project
---

v3.84.0 接管 onNeedPrivacyAuthorization + 自定义弹窗，真机头像（chooseAvatar）/昵称（type=nickname）点了无反应，弹窗没出现，resolve 未调用。v3.84.1 全部撤掉，只保留登录页勾选同意（本地 privacyAgreed）。

**Why:** 提审被拒「默认自动同意」，登录页勾选已解决合规点；官方弹窗交回微信平台。
**How to apply:** 以后不要再注册该监听或加 __usePrivacyCheck__，除非能真机验证；后台「用户隐私保护指引」需用户自己填。
