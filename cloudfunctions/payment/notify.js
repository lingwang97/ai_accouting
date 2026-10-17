// 新礼金订阅消息配置（主家不在小程序前台时，宾客点"我已完成转账"后通过微信服务通知提醒）
// 模板：小程序后台公共模板库选用的一次性订阅模板，字段 name4 / amount3 / time1 / thing5
// TMPL_ID 需与 miniprogram/config.js 中 NOTIFY_TMPL_ID 一致；为空时不发送，不影响主流程
module.exports = {
  TMPL_ID: 'eC0vKfrKjT6oBR187PU8HRIO85tW1EM8W-gqe9xjSqc',
  build: (r, timeStr) => ({
    // name：10 个以内纯汉字或 20 个以内纯字母，混排时去掉不合规字符
    name4: { value: nameValue(r.payerName) },
    amount3: { value: `${Number(r.amount).toFixed(2)}元` },
    time1: { value: timeStr },
    // thing：20 个字以内；优先礼品/备注，否则写礼簿名
    thing5: { value: String(r.remark || (r.themeName ? `${r.themeName} 待确认` : '新礼金待确认')).slice(0, 20) }
  })
};

function nameValue(name) {
  const s = String(name || '').trim();
  const cn = s.replace(/[^一-龥]/g, '');
  if (cn) return cn.slice(0, 10);
  const en = s.replace(/[^A-Za-z ]/g, '').trim();
  return (en || '宾客').slice(0, 20);
}
