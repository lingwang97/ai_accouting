---
name: project-membership-reserve
description: v3.62.0-3.64.0 会员预留（PDF主题/回执版式/额度/回收站天数/高峰模式/bookMax）已实现，全部先免费开放；压测结论
metadata:
  type: project
---

用户选 1A 2A 3(8小时3秒) 3bA 4A 5A 6A 7A 8B 9A：全部「预留、免费开放」，plans.features 缺项视为开放，只有 === false 才限制（featureOpen）。
提交：v3.62.0 d772681（pdfThemePremium、receiptStylePremium、去广告卡）、v3.63.0 4381702（maxBooks/maxClerks 额度仍 0 不限、trashDays、accounts.trashDays、purgeAt 固化）、v3.64.0 894204d（peakMode、accounts.peakUntil、warmer mode peak、bookMax free3000/pro6000）。
**Why:** 没有购买入口，立刻收费等于收回已有能力；收费时在 settings/plans 改 features 即可，不发版。
**How to apply:** plans.js 现已同步到 system/warmer/account/books/export/payment；脚本用 text 改文件注意部分文件是 CRLF（用 chr(13) 判断）；heredoc 别漏结尾 EOF，长脚本用 Write 工具。
压测：export 3000笔峰值RSS约443MB、6000笔618MB、10000笔815MB，约3秒/千笔；export 内存须在控制台调到 ≥512MB（推荐1024MB）。
fakedb 新增 db.persist（add/set 落数据）。
