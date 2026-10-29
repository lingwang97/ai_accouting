// utils/switchguard.js — 普通模式下切换「当前礼簿」前的两次确认（v3.66.4）
// 普通模式只有一本当前礼簿：礼簿码、宾客扫码、礼台记账、记账人都跟着它走，办事当天切换会让宾客记到新礼簿。
// 机构模式每场有自己的本场礼簿码，不拦。confirmSwitch 返回 Promise<boolean>：两次都确认才为 true。
const modal = opt => new Promise(resolve => wx.showModal({
  ...opt,
  success: r => resolve(!!r.confirm),
  fail: () => resolve(false)
}));

const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

/** orgMode 为 true 或没有原礼簿（第一本）时直接放行 */
async function confirmSwitch({ orgMode, fromName, toName }) {
  if (orgMode || !fromName) return true;
  const to = cut(toName, 12);
  const first = await modal({
    title: '切换当前礼簿',
    content: `切换后，礼簿码、宾客扫码随礼、礼台记账和记账人都会改记到新礼簿「${to}」。办事当天正在收礼时不建议切换；同一天办多场请使用机构模式。`,
    confirmText: '继续',
    cancelText: '取消'
  });
  if (!first) return false;
  return modal({
    title: '再次确认',
    content: `确定把当前礼簿从「${cut(fromName, 12)}」切换到「${to}」吗？`,
    confirmText: '确定切换',
    cancelText: '取消'
  });
}

module.exports = { confirmSwitch };
