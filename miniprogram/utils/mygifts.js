// utils/mygifts.js — 「我的随礼记录」（components/my-gifts）的页面侧辅助：宾客的 myreceipts 页与往来页第三栏共用
// 「分享给主家」按钮（open-type="share"）会触发所在页面的 onShareAppMessage，页面调用 shareOf 取分享内容。

/** 点「分享给主家」时返回转发卡片；不是这个按钮触发的返回 null，页面用自己的默认分享 */
function shareOf(e) {
  const d = e && e.from === 'button' && e.target && e.target.dataset;
  if (!d || !d.sharetitle) return null;
  return { title: String(d.sharetitle), path: '/pages/pending/pending' };
}

module.exports = { shareOf };
